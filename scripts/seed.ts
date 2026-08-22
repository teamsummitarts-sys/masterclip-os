/**
 * Seeds a demonstration project.
 *
 * Everything it creates is real: a real org and user, real shot versions
 * validated against the canonical schema, real character and world bible
 * entries. No render is submitted — `masterclip render submit` or the Shot
 * Builder does that, against the mock provider by default.
 */
import { createRuntime } from '@masterclip/runtime'
import { applyEnvFile } from '@masterclip/shared'
import { CharacterRecord, EnvironmentRecord, emptyShot } from '@masterclip/shot-schema'

// Before the reads below, not inside main(): SEED_EMAIL and SEED_PASSWORD are
// captured at module load.
applyEnvFile()

const DEV_PASSWORD = 'masterclip-dev-password'
const EMAIL = process.env.SEED_EMAIL ?? 'producer@masterclip.local'
const PASSWORD = process.env.SEED_PASSWORD || DEV_PASSWORD

// A deployed seed writes to a log stream that is retained and readable by
// anyone with access to the host's dashboard, so the password is echoed only
// when it is the published development one and therefore not a secret at all.
const passwordIsPublic = PASSWORD === DEV_PASSWORD
const credentials = passwordIsPublic ? `${EMAIL} / ${PASSWORD}` : `${EMAIL} (password: SEED_PASSWORD)`

async function main(): Promise<void> {
  const runtime = await createRuntime()

  const existingUser = await runtime.db.get<{ id: string; org_id: string }>('SELECT id, org_id FROM users WHERE email = ?', [EMAIL])
  let orgId: string
  let userId: string

  if (existingUser) {
    orgId = String(existingUser.org_id)
    userId = String(existingUser.id)
    console.log(`reusing existing account ${EMAIL}`)
  } else {
    // The owner account this creates can spend money and read every project in
    // the org. Reaching a public URL with the password that ships in this file is
    // the same as having no password, so refuse rather than create a known
    // account. The check lives here, not at the top of main(): this seed runs on
    // every container boot, and once the owner exists the password is never used
    // again — refusing to boot over an unused variable would turn a healthy,
    // already-seeded deployment into a crash loop.
    if (process.env.NODE_ENV === 'production' && passwordIsPublic) {
      console.error('refusing to create the owner account: set SEED_PASSWORD — the development default is public')
      await runtime.close()
      process.exit(1)
    }
    const org = await runtime.projects.createOrg('Summit Arts')
    const user = await runtime.auth.createUser({
      orgId: org.id,
      email: EMAIL,
      password: PASSWORD,
      displayName: 'Seed Producer',
      orgRole: 'owner',
    })
    orgId = org.id
    userId = user.id
    console.log(`created org ${org.id} and user ${credentials}`)
  }

  // Seeding establishes initial state; it does not append to it. A deployed
  // container runs this on every boot — every deploy, every restart, every wake
  // from idle — and without this guard each one would leave behind another
  // identical demo project. Set SEED_FORCE_PROJECT=1 to add a fresh one anyway.
  if (existingUser && process.env.SEED_FORCE_PROJECT !== '1') {
    const existingProjects = await runtime.projects.list(orgId)
    if (existingProjects.length > 0) {
      console.log(`org already seeded (${existingProjects.length} project(s)) — nothing to do`)
      console.log(`sign in as ${EMAIL}`)
      await runtime.close()
      return
    }
  }

  const project = await runtime.projects.create({
    orgId,
    name: `Neon Rain ${new Date().toISOString().slice(11, 19)}`,
    brief:
      'A late-night performance piece. One artist, one street, one neon sign. The camera is a witness, never a participant. Rain is the only weather; the sign is the only motivated light.',
    createdBy: userId,
  })
  await runtime.cost.budgetStore.ensureDefaults('project', project.id)
  console.log(`created project ${project.id} (${project.name})`)

  await runtime.bibles.createCharacter({
    projectId: project.id,
    createdBy: userId,
    record: CharacterRecord.parse({
      character_key: 'NOVA',
      name: 'Nova',
      // Deliberately left `unverified`: identity-locked rendering is refused
      // until a person records ownership and consent for real references.
      rights_status: 'unverified',
      consent_notes: 'demonstration character — no real likeness, no references attached',
      hair: 'wet dark bob, parted left',
      skin_tone: 'warm mid brown',
      makeup: 'minimal, high-shine lip',
      wardrobe: ['black leather jacket, cracked at the left elbow', 'charcoal slip dress'],
      accessories: ['single thin gold chain'],
      hands: 'short unpainted nails, silver ring on the right index finger',
      performance_behavior: 'still until the beat lands, then decisive; never fidgets',
      prohibited_expressions: ['broad smile'],
      prohibited_wardrobe_changes: ['no hat', 'jacket stays on'],
    }),
  })

  await runtime.bibles.createEnvironment({
    projectId: project.id,
    createdBy: userId,
    record: EnvironmentRecord.parse({
      environment_key: 'ALLEY',
      name: 'Rain alley, behind the venue',
      architectural_plan: 'narrow brick service alley, fire escape camera right, loading door camera left',
      primary_materials: ['wet brick', 'standing water on broken asphalt', 'painted steel door'],
      lighting_sources: ['magenta neon sign above the loading door', 'sodium spill from the street mouth'],
      time_of_day: '01:40, after rain',
      color_temperature: 'magenta key against sodium ambience',
      spatial_relationships: 'sign is 2.5m up camera left; street mouth is 12m behind the subject',
      reflections: 'full sign reflection in standing water, broken by footfalls',
      ground_plane: 'uneven asphalt, 2cm standing water in the low centre',
      atmosphere: 'no fog; only real rain haze near the sign',
      prohibited_changes: ['no added smoke', 'no additional light sources'],
    }),
  })

  const shots = [
    {
      shot_id: 'S01',
      title: 'Sign reflection, feet enter',
      shot_category: 'insert_detail' as const,
      narrative_purpose: 'Establish the place and the only light source before we see anyone.',
      action: 'Rain rings spread across the reflection of the neon sign; a pair of boots steps into frame and breaks it.',
      camera_position: 'low, 20cm above the water, looking straight down at the reflection',
      camera_movement: 'locked off',
      lens_mm: 35,
      aperture: 2.0,
      focus_behavior: 'focus holds on the water surface throughout',
      duration_seconds: 5,
      routing_profile: 'DRAFT_MOTION' as const,
      lighting: {
        dominant_source: 'magenta neon sign, reflected',
        source_position: 'above and behind camera left',
        color_temperature: 'magenta key, sodium edge',
        falloff: 'fast falloff into black at frame edges',
        shadow_behavior: 'no cast shadows; only the reflection reads',
        practicals: [],
      },
    },
    {
      shot_id: 'S02',
      title: 'Nova under the sign',
      shot_category: 'performance' as const,
      narrative_purpose: 'Meet her. The sign does all the work.',
      action: 'She stands still, then turns her head toward the street mouth as a car passes out of frame.',
      performance_direction: 'Stillness first. The turn is decisive, not curious.',
      blocking: 'centre frame, 1.5m from the brick wall, sign above and camera left',
      camera_position: 'medium, chest height, slightly below eye line',
      camera_movement: 'slow dolly in, 30cm over the shot',
      lens_mm: 50,
      aperture: 1.8,
      focus_behavior: 'focus holds on her eyes through the dolly',
      duration_seconds: 8,
      routing_profile: 'BALANCED' as const,
      lighting: {
        dominant_source: 'magenta neon sign, camera left and above',
        source_position: 'high camera left, 45 degrees',
        color_temperature: 'magenta key against cool sodium ambience',
        falloff: 'rapid falloff to the right side of her face',
        shadow_behavior: 'hard-edged shadow under the jaw, filling from the wet ground bounce',
        practicals: [{ fixture: 'neon sign', position: 'above the loading door', color: 'magenta', intensity: 'dominant' }],
      },
      environmental_motion: ['light rain', 'ripples in standing water'],
      material_requirements: [
        { material: 'wet leather jacket', behavior: 'specular highlights break along the creases; water beads rather than soaks' },
        { material: 'wet skin', behavior: 'subsurface warmth stays visible under the magenta key' },
      ],
      screen_direction: 'left_to_right' as const,
    },
    {
      shot_id: 'S03',
      title: 'Wide, alley and street mouth',
      shot_category: 'environment' as const,
      narrative_purpose: 'Give the space scale and put her back in the world.',
      action: 'She walks away from camera toward the street mouth; the sign holds frame left.',
      camera_position: 'wide, eye level, alley centre',
      camera_movement: 'handheld, minimal drift',
      lens_mm: 35,
      aperture: 2.8,
      duration_seconds: 8,
      routing_profile: 'DRAFT_MOTION' as const,
      continuity_from_shot: 'S02',
      screen_direction: 'away_from_camera' as const,
      lighting: {
        dominant_source: 'magenta neon sign, frame left',
        source_position: 'frame left, 2.5m up',
        color_temperature: 'magenta near, sodium far',
        falloff: 'she loses the key as she walks toward the street',
        shadow_behavior: 'long reflection trailing behind her in the water',
        practicals: [{ fixture: 'neon sign', position: 'frame left', color: 'magenta', intensity: 'dominant' }],
      },
    },
  ]

  for (const partial of shots) {
    const spec = emptyShot({
      ...partial,
      project_id: project.id,
      generation_mode: 'text_to_video',
      target_resolution: '720p',
      aspect_ratio: '16:9',
      candidate_count: 4,
      max_cost_usd: 1.5,
      environment_lock: { environment_key: 'ALLEY', environment_version: 0, strength: 'strict' },
      subjects: partial.shot_id === 'S01' ? [] : [{ character_key: 'NOVA', description: 'Nova', role: 'primary' }],
    })
    const created = await runtime.projects.createShot({ projectId: project.id, spec, createdBy: userId, note: 'seeded' })
    console.log(`  shot ${created.shot.shotKey} → ${created.shot.id}`)
  }

  console.log('')
  console.log(`sign in as ${credentials}`)
  console.log(`project id: ${project.id}`)
  console.log('next: pnpm masterclip render submit --shot <shotId> --count 4   (mock provider, no spend)')

  await runtime.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
