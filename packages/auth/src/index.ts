import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { type Db, insertRow, toStr } from '@masterclip/database'
import { AppError, forbidden, newId, randomToken, sha256Hex, systemClock, unauthorized, type Clock } from '@masterclip/shared'

const scrypt = promisify(scryptCb) as (p: string | Buffer, s: string | Buffer, k: number) => Promise<Buffer>

const SCRYPT_KEYLEN = 64
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000

export type OrgRole = 'owner' | 'admin' | 'member'
export type ProjectRole = 'producer' | 'director' | 'editor' | 'viewer'

export interface AuthUser {
  id: string
  orgId: string
  email: string
  displayName: string
  orgRole: OrgRole
}

export interface AuthContext {
  user: AuthUser
  sessionId: string
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new AppError({ kind: 'validation', code: 'auth.weak_password', message: 'password must be at least 10 characters' })
  }
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length)
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/**
 * Sessions are opaque random tokens; only their SHA-256 is stored. A database
 * leak therefore does not hand out live sessions.
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async createUser(input: {
    orgId: string
    email: string
    displayName: string
    password: string
    orgRole?: OrgRole
  }): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase()
    const existing = await this.db.get('SELECT id FROM users WHERE email = ?', [email])
    if (existing) throw new AppError({ kind: 'conflict', code: 'auth.email_taken', message: 'email already registered' })
    const user: AuthUser = {
      id: newId('usr'),
      orgId: input.orgId,
      email,
      displayName: input.displayName,
      orgRole: input.orgRole ?? 'member',
    }
    await insertRow(this.db, 'users', {
      id: user.id,
      org_id: user.orgId,
      email: user.email,
      display_name: user.displayName,
      password_hash: await hashPassword(input.password),
      org_role: user.orgRole,
      disabled: 0,
      created_at: this.clock.isoNow(),
    })
    return user
  }

  async login(email: string, password: string): Promise<{ token: string; user: AuthUser; expiresAt: string }> {
    const row = await this.db.get('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()])
    // Run the KDF even when the user does not exist so response timing does not
    // reveal which emails are registered.
    const storedHash = row ? toStr(row.password_hash) : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'
    const ok = await verifyPassword(password, storedHash)
    if (!row || !ok || row.disabled === 1) throw unauthorized('invalid email or password')
    return this.startSession(row)
  }

  /**
   * Opens a session for an account another authority has already vouched for:
   * Street Banker's signed hand-off (suite-sso.ts). Finds the account by email,
   * or creates it in `orgId` with a password nobody knows, since sign-in
   * happens at Street Banker. Never re-enables a disabled account.
   */
  async sessionForVouchedEmail(input: {
    email: string
    displayName: string
    orgId: string
    orgRole: OrgRole
  }): Promise<{ token: string; user: AuthUser; expiresAt: string; created: boolean }> {
    const email = input.email.trim().toLowerCase()
    let row = await this.db.get('SELECT * FROM users WHERE email = ?', [email])
    let created = false
    if (!row) {
      await this.createUser({ orgId: input.orgId, email, displayName: input.displayName, password: randomToken(32), orgRole: input.orgRole })
      row = await this.db.get('SELECT * FROM users WHERE email = ?', [email])
      created = true
    }
    if (!row || row.disabled === 1) throw forbidden('account disabled')
    return { ...(await this.startSession(row)), created }
  }

  private async startSession(row: Record<string, unknown>): Promise<{ token: string; user: AuthUser; expiresAt: string }> {
    const token = randomToken(32)
    const expiresAt = new Date(this.clock.now() + SESSION_TTL_MS).toISOString()
    await insertRow(this.db, 'sessions', {
      id: newId('ses'),
      user_id: toStr(row.id),
      token_hash: sha256Hex(token),
      created_at: this.clock.isoNow(),
      expires_at: expiresAt,
      revoked_at: null,
    })
    return { token, user: mapUser(row), expiresAt }
  }

  async resolve(token: string | undefined): Promise<AuthContext> {
    if (!token) throw unauthorized('missing session')
    const row = await this.db.get(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      [sha256Hex(token)],
    )
    if (!row) throw unauthorized('invalid session')
    if (row.revoked_at) throw unauthorized('session revoked')
    if (Date.parse(toStr(row.expires_at)) < this.clock.now()) throw unauthorized('session expired')
    if (row.disabled === 1) throw forbidden('account disabled')
    return { user: mapUser(row), sessionId: toStr(row.session_id) }
  }

  async logout(token: string): Promise<void> {
    await this.db.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [this.clock.isoNow(), sha256Hex(token)])
  }

  /**
   * Project authorization. Org owners and admins reach every project in their
   * org; everyone else needs an explicit membership row.
   */
  async requireProjectAccess(user: AuthUser, projectId: string, minimum: ProjectRole = 'viewer'): Promise<ProjectRole> {
    const project = await this.db.get('SELECT org_id FROM projects WHERE id = ?', [projectId])
    if (!project) throw new AppError({ kind: 'not_found', message: 'project not found' })
    if (toStr(project.org_id) !== user.orgId) throw forbidden('project belongs to another organization')
    if (user.orgRole === 'owner' || user.orgRole === 'admin') return 'producer'

    const membership = await this.db.get('SELECT member_role FROM project_members WHERE project_id = ? AND user_id = ?', [
      projectId,
      user.id,
    ])
    if (!membership) throw forbidden('no access to this project')
    const role = toStr(membership.member_role) as ProjectRole
    if (PROJECT_ROLE_RANK[role] < PROJECT_ROLE_RANK[minimum]) {
      throw forbidden(`requires ${minimum} access`)
    }
    return role
  }

  async addProjectMember(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    await this.db.run(
      `INSERT INTO project_members (project_id, user_id, member_role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET member_role = excluded.member_role`,
      [projectId, userId, role, this.clock.isoNow()],
    )
  }
}

export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  director: 3,
  producer: 4,
}

/** Spending money and approving masters are producer-level actions. */
export function canSpend(role: ProjectRole): boolean {
  return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK.director
}

export function canApproveMaster(role: ProjectRole): boolean {
  return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK.director
}

function mapUser(row: Record<string, unknown>): AuthUser {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    email: toStr(row.email),
    displayName: toStr(row.display_name),
    orgRole: toStr(row.org_role) as OrgRole,
  }
}

export * from './suite-sso.js'
