import Phaser from 'phaser'
import { formatCents } from '../treasury'
import { apprenticeSeats, memberSpot, stewardStand } from './actors'
import { stepAside } from './aside'
import { type Plan, planFor, stayAt } from './behavior'
import {
  integerZoom,
  openZoomWhole,
  type Phase,
  phaseAt,
  tintFor,
  walkPose,
  zoomAfterResize,
} from './daylight'
import { nearestTarget, REACH, reachPoint, sameTarget, type Target } from './interact'
import { bubbleCentreX, roomTags } from './layout'
import { lightIsOn } from './lighting'
import {
  browserStore,
  FADE_FRAME_MS,
  fadeInAlphas,
  fadeOutAlphas,
  locationName,
  rememberLocation,
  restoreLocation,
  signLines,
} from './location'
import { framesOf, GUILD_MASTER_ID, type LookChoice, lookFor } from './look'
import { type Atlases, actorDepth, roomZoom, viewportFor } from './render'
import { Retained } from './retained'
import { DEPTH, type Room } from './room'
import { drawRoom, makeShadow, moveShadow, preloadAtlases, registerAtlases } from './roomView'
import type { Spot } from './route'
import type { SceneBubble, SceneMember, SceneState } from './scene'
import { direction, findPath, followPath, type Keys, moveBy, SPEED, type Vec } from './walk'
import { replan, standing, stepWalker, type Walker } from './walker'
import {
  barrierNear,
  greatRoom,
  hallRoomOf,
  isRoomMapId,
  landingFor,
  MAP_IDS,
  type MapData,
  type MapId,
  type MapKey,
  mapData,
  mapSource,
  type PlaceName,
  placeNamed,
  roomKeys,
  roomOffset,
  type Step,
  setHalls,
  stepThrough,
} from './world'

/** Texture keys of the loaded art. */
const TILES = 'tiles'
const CHARS = 'chars'
const FONT = 'font'
const GLOW = 'glow'
const COURIER = 'courier'
const MAILBOX = 'mailbox'
const DOOR = 'door-closed'
const ENVELOPE = 'envelope'
/** The courier is drawn this much larger than a Member so it reads at any zoom. */
const COURIER_SCALE = 1.5
/** Where each map sits in the one Phaser world, in px: far apart so a camera sees only one. */
const OFFSETS: Record<MapId, Vec> = {
  hall: { x: 0, y: 0 },
  plaza: { x: 0, y: 30000 },
  archive: { x: 0, y: 60000 },
  'counting-house': { x: 0, y: 90000 },
  trail: { x: 0, y: 120000 },
}
/** Where a map sits in the one Phaser world: a town map at its fixed offset, a Hall room at its own. */
function offsetOf(map: MapKey): Vec {
  return isRoomMapId(map) ? roomOffset(map) : OFFSETS[map]
}

/** The room model of the Great Hall or a Hall room (null for a town map). */
function roomModel(map: MapKey): Room | null {
  return map === 'hall' ? greatRoom() : hallRoomOf(map)
}

/** Labels drawn over a map's named places and doors, at a tile. */
const MAP_LABELS: Record<MapId, { text: string; x: number; y: number }[]> = {
  hall: [],
  plaza: [
    { text: 'GUILD HALL', x: 3, y: 8 },
    { text: 'ARCHIVE', x: 15, y: 8 },
    { text: 'TREASURY', x: 27, y: 8 },
    { text: 'QUEST BOARD', x: 15, y: 9 },
    { text: 'TRAIL', x: 32, y: 12 },
  ],
  archive: [{ text: 'ARCHIVE', x: 6, y: 3 }],
  'counting-house': [{ text: 'TREASURY', x: 5, y: 3 }],
  trail: [{ text: 'THE WILDS', x: 23, y: 6 }],
}

/** Tile frames of the Kenney Roguelike/RPG sheet (row * 57 + column). */
const FRAME = { doorClosed: 32, doorOpen: 37, scroll: 899, coin: 1025 } as const

/** How long a speech bubble stays up, in ms. */
const BUBBLE_MS = 4500
/** Longest Quest title a bubble shows before it is cut. */
const BUBBLE_CHARS = 60
/** Width a bubble wraps at, in px. */
const BUBBLE_WRAP = 120
/** Most scrolls drawn on a Quest Board; the rest are a count. */
const BOARD_SCROLLS = 4
/** How long a Member takes to walk to the Quest Board and back to their desk, in ms. */
const WALK_MS = 600
/** Most scrolls drawn on the Seal desk; the rest are a count. */
const MAX_SCROLLS = 5

/** Callbacks and settings the page gives the scene. The game renders; it never writes. */
export interface HallOptions {
  /** True when the user asked for reduced motion: no walking, state changes are static swaps. */
  reducedMotion: boolean
  /** Opens a Quest's Seal in the ledger (navigation only). */
  onOpenSeal: (questId: string) => void
  /** Called with the name of the room the Guild Master has entered (the page announces it). */
  onLocation?: ((name: string) => void) | undefined
  /** Called with why a doorway is barred when the Guild Master stands at it, and with '' when they step away. */
  onNotice?: ((text: string) => void) | undefined
  /** Called when who the Guild Master could talk to changes (null: nobody in reach). */
  onNear: (target: Target | null) => void
  /** Called when a Member is clicked or tapped (inspect them). */
  onInspect?: ((memberId: string) => void) | undefined
  /** Called when the Guild Master presses E: talk to whoever is in reach. */
  onInteract: () => void
  /** The guild id: with a Member's id it seeds that Member's daily routine. */
  seed?: string | undefined
  /** Called when a Member hands a finished Quest in at the Quest Board (the page earns the banner). */
  onHandIn?: ((memberName: string) => void) | undefined
  /** Called when the Guild Master walks through a door into another map of the town. */
  onMap?: ((map: MapKey, tile: { x: number; y: number }) => void) | undefined
  /** Called after the world's rooms were rebuilt from the Halls (the mini map redraws from them). */
  onRooms?: (() => void) | undefined
  /** Called when the Guild Master steps onto another tile of the room (a tile change, not every frame). */
  onStep?: ((tile: { x: number; y: number }) => void) | undefined
  /** The height in px of the reserved HUD strip at the top of the canvas (the camera never draws under it). */
  hudHeight?: (() => number) | undefined
  /** Opens the Council panel (navigation only): a tap on the Council chamber. */
  onOpenCouncil?: (() => void) | undefined
}

/** The Guild Master's sprite name; its look is the saved one, or the one this id seeds. */
const GUILD_MASTER = GUILD_MASTER_ID
/** Longest a pointer may travel and still count as a tap, in px. */
const TAP_SLOP = 8

interface MemberView {
  root: Phaser.GameObjects.Container
  bubble: Phaser.GameObjects.Container | null
  bubbleTimer: Phaser.Time.TimerEvent | null
  /** The last bubble seq drawn, so a bubble shows once. */
  bubbleSeq: number
  /** The last claim seq acted on, so a claim walks to the Quest Board once. */
  claimSeq: number
  /** The Member's body in the town: map, position and what they are doing (plain data). */
  walker: Walker
  /** The finished-Quest seq already handed in, so a Quest is handed in once. */
  handedSeq: number
  /** The finished-Quest seq the plan in hand is handing in. */
  handingSeq: number
  /** The arrival count whose line was already said. */
  spoken: number
  /** The Member's name, for the hand-in banner. */
  name: string
  scroll: Phaser.GameObjects.Image
  sleep: Phaser.GameObjects.BitmapText
  shadow: Phaser.GameObjects.Image
}

/** An apprentice: a Sub-Quest's helper standing in its parent's room until the child settles. */
interface ApprenticeView {
  root: Phaser.GameObjects.Container
  hallId: string
  shadow: Phaser.GameObjects.Image
}

/** Keys that walk the Guild Master (lower-case `KeyboardEvent.key`). */
const KEY_NAMES: Record<string, keyof Keys | undefined> = {
  a: 'left',
  arrowleft: 'left',
  d: 'right',
  arrowright: 'right',
  w: 'up',
  arrowup: 'up',
  s: 'down',
  arrowdown: 'down',
}

const px = (tiles: number, size: number) => tiles * size

/**
 * The guild hall: a Tiled tilemap with a collision layer, a room per Hall, the Steward's desk, the
 * Seal desk, the gate and the coin counter. Members are separate containers addressable by Member
 * id (`memberObject`), so they can later become interactable NPCs; the camera is a fixed overview
 * that can `follow` a target. It renders a `SceneState` and decides nothing.
 */
export class HallScene extends Phaser.Scene {
  /** The Great Hall as last drawn, and what it was drawn from. */
  private hall: Room = greatRoom()
  private hallSig = ''
  /** Every room's sprites (the Great Hall under `hall`), destroyed and redrawn when the Halls change. */
  private roomSprites = new Map<MapKey, Phaser.GameObjects.GameObject[]>()
  /** Closed doors over Great Hall doorways: private ones open as the Guild Master nears, locked ones stay shut. */
  private doors: {
    sprite: Phaser.GameObjects.Image
    tile: { x: number; y: number }
    locked: boolean
  }[] = []
  /** The black the doorway fade draws over the view, and whether a fade is running. */
  private curtain: Phaser.GameObjects.Rectangle | null = null
  private fading = false
  /** True once the saved room was restored (or skipped) on the first state. */
  private restored = false
  /** The reason last announced for a barred doorway at hand ('' when none). */
  private notice = ''
  private atlases: Atlases = { interiors: {}, furniture: {} }
  private hudHeight = 0
  private readonly options: HallOptions
  private readonly members = new Map<string, MemberView>()
  /** Rooms, gate, scrolls and the coin counter, kept by key and redrawn only when their inputs change. */
  private readonly dynamic = new Retained<Phaser.GameObjects.GameObject>((o) => {
    o.destroy()
  })
  private pending: SceneState | null = null
  private ready = false
  private readonly apprentices = new Map<string, ApprenticeView>()
  /** True until the first state is drawn: what already happened is shown, not animated. */
  private seeding = true
  /** The newest courier seq already walked (or skipped while seeding), so each trip walks once. */
  private courierSeq = 0
  /** Couriers still walking, by seq: their addressee's bubble waits for them. */
  private readonly walkingCouriers = new Map<number, string | null>()
  private zoomLevel = 1
  private followed: string | null = null
  private player: Phaser.GameObjects.Container | null = null
  private playerLayers: Phaser.GameObjects.Image[] = []
  private playerShadow: Phaser.GameObjects.Image | null = null
  private playerLook: LookChoice | null = null
  private at: Vec = { x: this.hall.spawn.x + 0.5, y: this.hall.spawn.y + 0.5 }
  /** The last tile reported through `onStep`. */
  private stepped = { x: -1, y: -1 }
  private path: Vec[] = []
  private chasing = false
  /** The map of the town the Guild Master is in. */
  private current: MapKey = 'hall'
  /** The map the camera shows: the Guild Master's, unless the camera follows a Member elsewhere. */
  private viewMap: MapKey = 'hall'
  private phase: Phase = phaseAt(new Date().getHours())
  private phaseForced = false
  private veil: Phaser.GameObjects.Rectangle | null = null
  private lanterns: Phaser.GameObjects.Image[] = []
  private facingLeft = false
  private clock = 0
  private slotForced: number | null = null
  private startPlace: PlaceName | null = null
  /** Members of a Hall (not the Steward): the ones the Guild Master can talk to. */
  private talkable = new Set<string>()
  private near: Target | null = null
  /** True while a Council session is open: the elders confer. */
  private councilState: 'idle' | 'conferring' | 'halted' = 'idle'
  private readonly keys: Keys = { left: false, right: false, up: false, down: false }
  private detachKeys: (() => void) | null = null

  constructor(options: HallOptions) {
    super('hall')
    this.options = options
  }

  preload(): void {
    this.load.spritesheet(TILES, '/game/tiles.png', { frameWidth: 16, frameHeight: 16, spacing: 1 })
    this.load.spritesheet(CHARS, '/game/chars.png', { frameWidth: 16, frameHeight: 16, spacing: 1 })
    this.load.bitmapFont(FONT, '/game/font.png', '/game/font.fnt')
    preloadAtlases(this)
  }

  create(): void {
    this.input.enabled = this.inputOn
    this.atlases = registerAtlases(this)
    for (const id of MAP_IDS) {
      this.drawMap(id)
    }
    this.makeGlow()
    this.makeDoor()
    this.makeCourier()
    this.makeMailbox()
    // The routine moves on with the clock: re-plan the Members every ten seconds.
    this.time.addEvent({
      delay: 10_000,
      loop: true,
      callback: () => {
        if (this.pending) {
          this.drawMembers(this.pending)
        }
      },
    })
    this.veil = this.add
      .rectangle(0, 0, 1, 1, 0xffffff, 0)
      .setOrigin(0, 0)
      .setDepth(DEPTH.top)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
    this.curtain = this.add
      .rectangle(0, 0, 1, 1, 0x000000, 0)
      .setOrigin(0, 0)
      .setDepth(DEPTH.top + 50)
    this.time.addEvent({
      delay: 60_000,
      loop: true,
      callback: () => {
        if (!this.phaseForced) {
          this.setPhase(phaseAt(new Date().getHours()), false)
        }
      },
    })
    // Refit only when the canvas really changed size: Phaser also emits `resize` after a zoom.
    let size = `${this.scale.width}x${this.scale.height}`
    this.scale.on('resize', () => {
      const next = `${this.scale.width}x${this.scale.height}`
      if (next !== size) {
        size = next
        this.fit(true)
      }
    })
    this.createPlayer()
    this.frameMap()
    this.setPhase(this.phase, this.phaseForced)
    this.ready = true
    if (this.pending) {
      this.render(this.pending)
    }
    if (this.startPlace) {
      this.goTo(this.startPlace)
    }
  }

  /** Starts the Guild Master at a named place instead of the entrance (QA: `?at=`). */
  startAt(place: PlaceName): void {
    this.startPlace = place
  }

  /** The Guild Master's game object (null before the scene has loaded). */
  guildMasterObject(): Phaser.GameObjects.Container | null {
    return this.player
  }

  /** Dresses the Guild Master in a look (safe before the scene has loaded; the latest look wins). */
  setPlayerLook(look: LookChoice): void {
    this.playerLook = look
    const frames = framesOf(look)
    const [body, outfit, hair] = this.playerLayers
    body?.setFrame(frames.body)
    outfit?.setFrame(frames.outfit)
    hair?.setFrame(frames.hair)
  }

  /** Moves the Guild Master into a Hall's room (its slot) or back to the Great Hall entrance (null). */
  teleport(slot: number | null): void {
    const key = slot === null ? 'hall' : roomKeys()[slot]
    const spot = key === undefined ? null : landingFor(key)
    if (key === undefined || spot === null) {
      return
    }
    this.chasing = true
    this.enter(key, { x: spot.x + 0.5, y: spot.y + 0.5 })
  }

  /** Walks the Guild Master to a named place in whatever map it is in (a point for behaviour code to target). */
  goTo(name: PlaceName): void {
    const place = placeNamed(name)
    this.enter(place.map, { x: place.stand.x + 0.5, y: place.stand.y + 0.5 })
  }

  /** The map of the town (or Hall room) the Guild Master is in. */
  currentMap(): MapKey {
    return this.current
  }

  /** Sets the time of day the world is lit for; a forced phase stops following the clock. */
  setPhase(phase: Phase, forced = true): void {
    this.phase = phase
    this.phaseForced = forced
    this.applyTint()
    if (this.pending && this.ready) {
      this.drawMembers(this.pending)
    }
  }

  /** Moves the Guild Master into a map at a tile position, framing the camera on it. */
  private enter(id: MapKey, at: Vec): void {
    this.stepped = { x: Math.floor(at.x), y: Math.floor(at.y) }
    this.current = id
    this.viewMap = id
    this.at = { ...at }
    this.path = []
    this.releaseKeys()
    this.frameMap()
    this.applyTint()
    this.syncPlayer()
    this.chase(true)
    this.options.onMap?.(id, { x: Math.floor(this.at.x), y: Math.floor(this.at.y) })
    const rooms = this.pending?.rooms ?? []
    this.options.onLocation?.(
      locationName(id, (hallId) => rooms.find((r) => r.hallId === hallId)?.name)
    )
    if (this.options.seed) {
      rememberLocation(browserStore(), this.options.seed, id)
    }
  }

  /**
   * Walks through a doorway: four stepped frames to black, the Guild Master appears at the entry of
   * the next map facing in, four frames back. Reduced motion cuts instantly. Nothing else moves the
   * Guild Master while it runs.
   */
  private travel(step: Step): void {
    if (this.fading) {
      return
    }
    this.fading = true
    this.path = []
    this.releaseKeys()
    const reduced = this.options.reducedMotion
    this.runFade(fadeOutAlphas(reduced), () => {
      this.enter(step.to, { x: step.at.x + 0.5, y: step.at.y + 0.5 })
      this.facingLeft = false
      this.runFade(fadeInAlphas(reduced), () => {
        this.fading = false
      })
    })
  }

  /** Plays the stepped black opacities one frame at a time, then calls `done` (at once when there are none). */
  private runFade(alphas: readonly number[], done: () => void): void {
    if (alphas.length === 0) {
      this.setCurtain(0)
      done()
      return
    }
    let frame = 0
    const tick = () => {
      this.setCurtain(alphas[frame] ?? 0)
      frame++
      this.time.delayedCall(FADE_FRAME_MS, frame < alphas.length ? tick : done)
    }
    tick()
  }

  /** Sets how black the view is, covering whatever the camera shows. */
  private setCurtain(alpha: number): void {
    this.curtainAlpha = alpha
    this.fitCurtain()
  }

  private curtainAlpha = 0

  private fitCurtain(): void {
    const view = this.cameras.main.worldView
    this.curtain
      ?.setPosition(view.x - 4, view.y - 4)
      .setSize(view.width + 8, view.height + 8)
      .setFillStyle(0x000000, this.curtainAlpha)
  }

  /** The canvas area the camera draws in: everything below the reserved HUD strip. */
  private viewport(): { w: number; h: number } {
    const v = viewportFor({ w: this.scale.width, h: this.scale.height }, this.hudHeight)
    this.cameras.main.setViewport(v.x, v.y, v.w, v.h)
    return v
  }

  /** Bounds the camera to the current map, opens at a whole zoom and centres on the Guild Master. */
  private frameMap(): void {
    const cam = this.cameras.main
    const { x, y } = offsetOf(this.viewMap)
    const map = this.mapOf(this.viewMap)
    const w = px(map.width, map.tileSize)
    const h = px(map.height, map.tileSize)
    const view = this.viewport()
    // A room opens at the largest whole zoom that shows all of it; a town map fills the frame.
    this.zoomLevel =
      roomModel(this.viewMap) !== null
        ? roomZoom(view, { w, h })
        : openZoomWhole(view.w, view.h, w, h)
    cam.setZoom(this.zoomLevel)
    this.boundCamera()
    if (this.viewMap === this.current) {
      cam.centerOn(x + this.at.x * map.tileSize, y + this.at.y * map.tileSize)
    }
  }

  /**
   * Bounds the camera to the current map, padded to the view when the map is smaller than it, so a
   * small map sits in the middle of the frame instead of in its corner.
   */
  private boundCamera(): void {
    const cam = this.cameras.main
    const { x, y } = offsetOf(this.viewMap)
    const map = this.mapOf(this.viewMap)
    const w = px(map.width, map.tileSize)
    const h = px(map.height, map.tileSize)
    const boundW = Math.max(w, cam.width / cam.zoom)
    const boundH = Math.max(h + 2 * map.tileSize, cam.height / cam.zoom)
    cam.setBounds(x - (boundW - w) / 2, y - (boundH - h) / 2, boundW, boundH)
  }

  /** Lays the world tint over the current map only, and lights the room's lamps, sconces and windows. */
  private applyTint(): void {
    // Before the scene has loaded there is nothing to tint: `create` applies the stored phase.
    if (!this.veil) {
      return
    }
    const tint = tintFor(this.phase)
    const { x, y } = offsetOf(this.viewMap)
    const map = this.mapOf(this.viewMap)
    const model = roomModel(this.viewMap)
    this.veil
      .setPosition(x, y)
      .setSize(px(map.width, map.tileSize), px(map.height, map.tileSize))
      .setFillStyle(tint.color, tint.alpha)
    for (const lantern of this.lanterns) {
      lantern.destroy()
    }
    this.lanterns = []
    const lit =
      model !== null
        ? model.lights.filter((l) => lightIsOn(this.phase, l)).map((l) => l.tile)
        : tint.lanterns
          ? map.lanterns
          : []
    for (const lantern of lit) {
      this.lanterns.push(
        this.add
          .image(x + (lantern.x + 0.5) * map.tileSize, y + (lantern.y + 0.5) * map.tileSize, GLOW)
          .setDepth(DEPTH.top + 1)
          .setBlendMode(Phaser.BlendModes.ADD)
      )
    }
  }

  /** A map's data (the Great Hall's size follows the Halls it has doorways for). */
  private mapOf(id: MapKey): MapData {
    return mapData(id)
  }

  /**
   * Rebuilds the Great Hall and every Hall's room when the Halls or their Members change: a doorway
   * and a sign per Hall, a room sized to its Members, a corridor past six Halls. A Hall added in the
   * Guild builder gets its room here.
   */
  private fitHall(state: SceneState): void {
    const specs = state.rooms.map((r, index) => ({
      hall: { id: r.hallId, name: r.name, kind: r.kind, locked: r.locked, index },
      members: r.memberIds.map((id) => ({ id, captain: state.members[id]?.rank === 'captain' })),
    }))
    const sig = JSON.stringify(specs)
    if (sig === this.hallSig || !this.ready) {
      return
    }
    this.hallSig = sig
    setHalls(specs)
    this.options.onRooms?.()
    this.hall = greatRoom()
    for (const objects of this.roomSprites.values()) {
      for (const object of objects) {
        object.destroy()
      }
    }
    this.roomSprites = new Map()
    this.roomSprites.set('hall', drawRoom(this, this.hall, this.atlases, OFFSETS.hall))
    for (const key of roomKeys()) {
      const room = hallRoomOf(key)
      if (room) {
        this.roomSprites.set(key, drawRoom(this, room, this.atlases, roomOffset(key)))
      }
    }
    // A Hall that is gone or locked sends the Guild Master back to the Great Hall; a shrunk room can leave them off the floor.
    if (this.current !== 'hall' && landingFor(this.current) === null) {
      const spot = this.hall.spawn
      this.enter('hall', { x: spot.x + 0.5, y: spot.y + 0.5 })
    } else if (!mapData(this.current).walkable(Math.floor(this.at.x), Math.floor(this.at.y))) {
      const spot = roomModel(this.current)?.spawn ?? this.hall.spawn
      this.at = { x: spot.x + 0.5, y: spot.y + 0.5 }
    }
    if (roomModel(this.viewMap) !== null) {
      this.frameMap()
    }
    this.applyTint()
  }

  /** Opens the room the guild last stood in, once, on the first state (the Great Hall when it is gone or storage is blocked). */
  private restoreRoom(): void {
    if (this.restored) {
      return
    }
    this.restored = true
    if (this.startPlace || !this.options.seed) {
      return
    }
    const key = restoreLocation(browserStore(), this.options.seed, (k) => landingFor(k) !== null)
    const spot = key === 'hall' ? null : landingFor(key)
    if (spot) {
      this.enter(key, { x: spot.x + 0.5, y: spot.y + 0.5 })
    }
  }

  /** One of the town's maps as tile layers at its offset; the Great Hall is drawn by `fitHall`. */
  private drawMap(id: MapId): void {
    if (id === 'hall') {
      this.roomSprites.set('hall', drawRoom(this, this.hall, this.atlases, OFFSETS.hall))
      return
    }
    const source = mapSource(id)
    const key = `map-${id}`
    this.cache.tilemap.add(key, { format: Phaser.Tilemaps.Formats.TILED_JSON, data: source })
    const map = this.make.tilemap({ key })
    const tileset = map.addTilesetImage('roguelike', TILES, 16, 16, 0, 1)
    if (!tileset) {
      return
    }
    const { x, y } = OFFSETS[id]
    for (const name of ['floor', 'walls', 'furniture']) {
      map.createLayer(name, tileset, x, y)
    }
    for (const label of MAP_LABELS[id]) {
      this.label(x + label.x * 16, y + label.y * 16, label.text, 16)
    }
  }

  /** A Hall's mailbox, drawn in code: a post, a wooden box with a slot and a red flag. */
  private makeMailbox(): void {
    const g = this.add.graphics()
    const paint = (colour: number, x: number, y: number, w: number, h: number) => {
      g.fillStyle(colour, 1)
      g.fillRect(x, y, w, h)
    }
    paint(0x3b2410, 7, 9, 2, 7) // post
    paint(0x7a4b24, 2, 3, 12, 7) // box
    paint(0x3b2410, 2, 3, 12, 1) // lid edge
    paint(0x3b2410, 4, 6, 6, 1) // slot
    paint(0xb8453a, 12, 0, 2, 4) // flag
    g.generateTexture(MAILBOX, 16, 16)
    g.destroy()
  }

  /** A closed wooden door, drawn in code: planks, a frame and a brass handle, filling one tile. */
  private makeDoor(): void {
    const g = this.add.graphics()
    const paint = (colour: number, x: number, y: number, w: number, h: number) => {
      g.fillStyle(colour, 1)
      g.fillRect(x, y, w, h)
    }
    paint(0x3b2410, 1, 0, 14, 16) // frame
    paint(0x7a4b24, 2, 1, 12, 15) // planks
    paint(0x5e3a1c, 5, 1, 1, 15) // plank seams
    paint(0x5e3a1c, 10, 1, 1, 15)
    paint(0xd9b24a, 11, 8, 2, 2) // handle
    g.generateTexture(DOOR, 16, 16)
    g.destroy()
  }

  /**
   * The courier, drawn in code (no image asset): a figure in a cap and blue coat, hard-edged pixel
   * rectangles from the sprite palette, filling the same 16 by 16 cell a Member does. The soft
   * envelope it carries is a second texture so it can bob on its own.
   */
  private makeCourier(): void {
    const g = this.add.graphics()
    const paint = (colour: number, x: number, y: number, w: number, h: number) => {
      g.fillStyle(colour, 1)
      g.fillRect(x, y, w, h)
    }
    paint(0x3b2410, 4, 0, 8, 3) // cap
    paint(0x3b2410, 3, 2, 10, 1) // brim
    paint(0xe8b98a, 5, 3, 6, 4) // face
    paint(0x2f5d8a, 3, 7, 10, 6) // coat
    paint(0xf2e6c8, 7, 7, 2, 6) // coat trim
    paint(0x3b2410, 4, 13, 3, 3) // boots
    paint(0x3b2410, 9, 13, 3, 3)
    g.generateTexture(COURIER, 16, 16)
    g.clear()
    paint(0xf2e6c8, 0, 1, 10, 7) // the envelope
    paint(0xd9c9a3, 0, 1, 10, 1) // its flap edge
    paint(0xd9c9a3, 1, 2, 2, 1)
    paint(0xd9c9a3, 7, 2, 2, 1)
    paint(0xd9c9a3, 3, 3, 4, 1)
    paint(0xb8453a, 4, 4, 2, 2) // its seal
    g.generateTexture(ENVELOPE, 10, 9)
    g.destroy()
  }

  /**
   * A courier walks from the sending Hall's room, out its door, to the receiving Hall's door and
   * in, once per cross-Hall event. Nothing walks while the first state is only being shown, and
   * with reduced motion the letter simply arrives. The addressee's "From" bubble is held back
   * until the courier arrives.
   */
  private drawCouriers(state: SceneState): void {
    for (const courier of state.couriers) {
      if (courier.seq <= this.courierSeq) {
        continue
      }
      this.courierSeq = courier.seq
      if (this.seeding || this.options.reducedMotion) {
        continue
      }
      const door = (hallId: string) => this.hall.doorways.find((d) => d.hallId === hallId)
      const from = door(courier.fromHall)
      const to = door(courier.toHall)
      if (!from || !to || from === to) {
        continue
      }
      const at = (x: number, y: number) => ({ x: x * 16 + 8, y: y * 16 + 8 })
      const route = [
        at(from.tile.x, from.tile.y),
        at(from.tile.x, from.tile.y + 1),
        at(to.tile.x, to.tile.y + 1),
        at(to.tile.x, to.tile.y),
      ]
      const start = route[0]
      if (!start) {
        continue
      }
      const sprite = this.add.image(start.x, start.y, COURIER).setDepth(actorDepth(start.y + 8))
      sprite.setScale(COURIER_SCALE)
      sprite.setName(`courier:${courier.seq}`)
      // The envelope rides in the courier's hands, a little ahead and above, and follows it.
      const envelope = this.add.image(start.x, start.y, ENVELOPE).setDepth(DEPTH.top - 1)
      envelope.setScale(COURIER_SCALE)
      const follow = () => {
        envelope.setPosition(sprite.x + 12, sprite.y - 4)
        sprite.setDepth(actorDepth(sprite.y + 8))
      }
      follow()
      this.walkingCouriers.set(courier.seq, courier.toMemberId)
      const step = (n: number) => {
        const to = route[n]
        if (!to) {
          sprite.destroy()
          envelope.destroy()
          this.walkingCouriers.delete(courier.seq)
          if (this.pending) {
            this.render(this.pending)
          }
          return
        }
        this.tweens.add({
          targets: sprite,
          x: to.x,
          y: to.y,
          duration: WALK_MS,
          ease: 'Linear',
          onUpdate: follow,
          onComplete: () => step(n + 1),
        })
      }
      step(1)
    }
  }

  /** The courier's game object, by the seq of the event that sent it (null when none is walking). */
  courierObject(seq: number): Phaser.GameObjects.Image | null {
    const found = this.children.getByName(`courier:${seq}`)
    return found instanceof Phaser.GameObjects.Image ? found : null
  }

  /** A stepped lantern glow: four hard-edged rings of warm light, no gradient. */
  private makeGlow(): void {
    const g = this.add.graphics()
    g.fillStyle(0xffc66b, 0.09)
    for (const r of [28, 21, 14, 7]) {
      g.fillCircle(28, 28, r)
    }
    g.generateTexture(GLOW, 56, 56)
    g.destroy()
  }

  /** Per frame: held keys walk the Guild Master, otherwise a tapped path is followed. */
  override update(_time: number, delta: number): void {
    // The HUD changes height with its content: refit the viewport below it when it does.
    const hud = this.options.hudHeight?.() ?? 0
    if (hud !== this.hudHeight) {
      this.hudHeight = hud
      this.fit(true)
    }
    for (const view of this.members.values()) {
      const height = view.bubble?.getData('height')
      if (view.bubble && typeof height === 'number') {
        // Above the speaker, or below when that would cover a room label; a tall (wrapped) bubble
        // moves away from the speaker by its extra height.
        const { x, y } = view.root
        const centre = y - 26
        const extra = (height - 20) / 2
        const wide = view.bubble.getData('width')
        const left =
          typeof wide === 'number' ? bubbleCentreX(this.cameras.main.worldView, wide, x) : x
        view.bubble.setPosition(left, centre < y ? centre - extra : centre + extra)
      }
    }
    this.stepMembers(Math.min(delta, 100) / 1000)
    if (!this.player) {
      return
    }
    this.sortActors()
    if (this.fading) {
      this.fitCurtain()
      this.syncPlayer()
      return
    }
    const seconds = Math.min(delta, 100) / 1000
    const dir = direction(this.keys)
    const walkable = this.canWalk()
    let walking = false
    if (dir.x !== 0 || dir.y !== 0) {
      this.path = []
      this.at = moveBy(this.at, dir.x * SPEED * seconds, dir.y * SPEED * seconds, walkable)
      walking = true
      if (dir.x !== 0) {
        this.facingLeft = dir.x < 0
      }
      this.chase(false)
    } else if (this.path.length > 0) {
      const before = this.at.x
      const next = followPath(this.at, this.path, SPEED * seconds)
      this.at = next.pos
      this.path = next.path
      walking = true
      if (this.at.x !== before) {
        this.facingLeft = this.at.x < before
      }
      this.chase(false)
    }
    this.clock = walking ? this.clock + Math.min(delta, 100) : 0
    this.pose(this.player, walkPose(this.clock, walking), this.facingLeft)
    for (const view of this.members.values()) {
      const walking = view.walker.path.length > 0 || view.walker.legs.length > 0
      this.pose(view.root, walkPose(this.time.now, walking), view.walker.facingLeft)
    }
    const tile = { x: Math.floor(this.at.x), y: Math.floor(this.at.y) }
    if (tile.x !== this.stepped.x || tile.y !== this.stepped.y) {
      this.stepped = tile
      this.options.onStep?.(tile)
    }
    const step = stepThrough(this.current, tile)
    if (step) {
      this.travel(step)
      return
    }
    this.syncPlayer()
    this.updateNear()
    this.updateDoors(tile)
  }

  /** The walkable test of the map the Guild Master is in (the Great Hall's has locked doorways shut). */
  private canWalk(): (x: number, y: number) => boolean {
    return mapData(this.current).walkable
  }

  /** Opens a private door as the Guild Master nears it, and announces why a barred doorway at hand is shut. */
  private updateDoors(tile: { x: number; y: number }): void {
    for (const door of this.doors) {
      const near =
        this.current === 'hall' && Math.hypot(door.tile.x - tile.x, door.tile.y - tile.y) < 2.5
      door.sprite.setVisible(door.locked || !near)
    }
    const reason = barrierNear(this.current, tile) ?? ''
    if (reason !== this.notice) {
      this.notice = reason
      this.options.onNotice?.(reason)
    }
  }

  /** Applies a walk-cycle pose to a character's layers: a lift and a lean per frame, flipped when facing left. */
  private pose(
    root: Phaser.GameObjects.Container | null,
    pose: { lift: number; lean: number },
    flip: boolean
  ): void {
    if (!root) {
      return
    }
    for (const child of root.list) {
      if (child instanceof Phaser.GameObjects.Image && child.name !== 'badge') {
        child.setPosition(flip ? -pose.lean : pose.lean, pose.lift)
        child.setFlipX(flip)
      } else if (child instanceof Phaser.GameObjects.Graphics) {
        child.setPosition(flip ? -pose.lean : pose.lean, pose.lift)
      }
    }
  }

  /** Reports who is in reach (a Member, the Seal desk, the Council table or this Hall's mailbox) whenever that changes. */
  private updateNear(): void {
    const s = this.hall.tileSize
    const targets: { target: Target; at: Vec }[] = []
    const room = roomModel(this.current)
    const { x: ox, y: oy } = offsetOf(this.current)
    for (const id of this.talkable) {
      const view = this.members.get(id)
      if (view && view.walker.map === this.current) {
        targets.push({
          target: { kind: 'member', id },
          at: { x: (view.root.x - ox) / s, y: (view.root.y - oy) / s },
        })
      }
    }
    for (const poi of room?.pois ?? []) {
      if (poi.kind === 'seal-desk') {
        targets.push({ target: { kind: 'sealDesk' }, at: reachPoint(poi.tile, this.at) })
      } else if (poi.kind === 'council-table') {
        targets.push({ target: { kind: 'council' }, at: reachPoint(poi.tile, this.at) })
      } else if (poi.kind === 'mailbox' && isRoomMapId(this.current)) {
        // A Hall's mailbox stands in its own room.
        targets.push({
          target: { kind: 'mailbox', hallId: this.current.slice('hall:'.length) },
          at: reachPoint(poi.tile, this.at),
        })
      }
    }
    const now = nearestTarget(this.at, targets, REACH)
    if (!sameTarget(now, this.near)) {
      this.near = now
      this.options.onNear(now)
    }
  }

  /** Every character sorts by its feet and casts a hard shadow; Members in another map follow their own root. */
  private sortActors(): void {
    const feet = (root: Phaser.GameObjects.Container, reach: number) => ({
      x: root.x,
      y: root.y + reach,
    })
    const place = (
      root: Phaser.GameObjects.Container,
      shadow: Phaser.GameObjects.Image | null,
      reach: number,
      shown: boolean
    ) => {
      const foot = feet(root, reach)
      root.setDepth(actorDepth(foot.y))
      if (shadow) {
        moveShadow(shadow, foot)
        shadow.setVisible(shown)
      }
    }
    for (const view of this.members.values()) {
      place(view.root, view.shadow, 8, !view.walker.hidden)
    }
    for (const view of this.apprentices.values()) {
      place(view.root, view.shadow, 6, view.root.alpha > 0.2)
    }
    if (this.player) {
      place(this.player, this.playerShadow, 8, true)
    }
  }

  /** A small gold crown over the head: the one thing that tells the Guild Master from a Member. */
  private crown(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics()
    g.fillStyle(0xffd23f, 1)
    g.lineStyle(1, 0x5b4200, 1)
    const points = [
      [-4, -5],
      [-4, -11],
      [-2, -8],
      [0, -12],
      [2, -8],
      [4, -11],
      [4, -5],
    ].map(([x, y]) => new Phaser.Math.Vector2(x, y))
    g.fillPoints(points, true)
    g.strokePoints(points, true)
    return g
  }

  private createPlayer(): void {
    const look = lookFor(GUILD_MASTER, this.playerLook ?? undefined)
    this.playerLayers = [look.body, look.outfit, look.hair].map((frame) =>
      this.add.image(0, 0, CHARS, frame)
    )
    const layers: Phaser.GameObjects.GameObject[] = [...this.playerLayers, this.crown()]
    this.player = this.add.container(0, 0, layers)
    this.playerShadow = makeShadow(this)
    this.player.setName(GUILD_MASTER)
    this.syncPlayer()
    const down = (event: KeyboardEvent) => this.onKey(event, true)
    const up = (event: KeyboardEvent) => this.onKey(event, false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    const blur = () => this.releaseKeys()
    window.addEventListener('blur', blur)
    this.detachKeys = () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.detachKeys?.())
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.detachKeys?.())
    // A tap or click (not a drag) walks to that tile.
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      const moved = Math.hypot(pointer.upX - pointer.downX, pointer.upY - pointer.downY)
      if (moved > TAP_SLOP || this.input.hitTestPointer(pointer).length > 0) {
        return
      }
      const s = this.hall.tileSize
      const { x: ox, y: oy } = offsetOf(this.current)
      const to = {
        x: Math.floor((pointer.worldX - ox) / s),
        y: Math.floor((pointer.worldY - oy) / s),
      }
      const from = { x: Math.floor(this.at.x), y: Math.floor(this.at.y) }
      const route = findPath(this.canWalk(), from, to)
      if (route) {
        this.path = route
        this.chase(false)
      }
    })
  }

  private onKey(event: KeyboardEvent, pressed: boolean): void {
    const name = KEY_NAMES[event.key.toLowerCase()]
    // A key is always released, even if focus moved into a dialog while it was held.
    if (!pressed) {
      if (name) {
        this.keys[name] = false
      }
      return
    }
    const target = event.target
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest('dialog') !== null ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
    ) {
      return
    }
    if (event.key.toLowerCase() === 'e') {
      if (!event.repeat && this.near !== null) {
        this.releaseKeys()
        this.options.onInteract()
        event.preventDefault()
      }
      return
    }
    if (name) {
      this.keys[name] = true
      event.preventDefault()
    }
  }

  private releaseKeys(): void {
    this.keys.left = this.keys.right = this.keys.up = this.keys.down = false
  }

  /** Puts the sprite on the Guild Master's position. */
  private syncPlayer(): void {
    const s = this.hall.tileSize
    const { x: ox, y: oy } = offsetOf(this.current)
    this.player?.setPosition(ox + this.at.x * s, oy + this.at.y * s)
    this.sortActors()
  }

  /** Follows the Guild Master with the camera: no easing under reduced motion. */
  private chase(snap: boolean): void {
    const cam = this.cameras.main
    if (this.player && this.viewMap !== this.current) {
      // The camera was off following a Member in another map: come home to the Guild Master.
      this.viewMap = this.current
      this.frameMap()
      this.applyTint()
      this.chasing = false
    }
    if (this.player && (!this.chasing || snap)) {
      this.chasing = true
      this.followed = GUILD_MASTER
      if (this.zoomLevel < 1) {
        this.zoomLevel = 1
        cam.setZoom(1)
      }
      const ease = this.options.reducedMotion ? 1 : 0.12
      cam.startFollow(this.player, true, ease, ease)
      if (snap) {
        cam.centerOn(this.player.x, this.player.y)
      }
    }
  }

  /** The Member's game object, by Member id (null before it is drawn). */
  memberObject(id: string): Phaser.GameObjects.Container | null {
    return this.members.get(id)?.root ?? null
  }

  /** Draws a new scene state. Safe to call before the scene has loaded; the latest state wins. */
  render(state: SceneState): void {
    this.pending = state
    if (!this.ready) {
      return
    }
    this.fitHall(state)
    this.restoreRoom()
    this.drawDynamic(state)
    this.drawCouriers(state)
    this.drawMembers(state)
    this.drawApprentices(state)
    this.seeding = false
  }

  /** Zooms the camera one whole step in or out (1x to 4x), keeping the map centred. */
  zoomBy(step: number): void {
    this.zoomLevel = Math.min(4, Math.max(1, this.zoomLevel + Math.sign(step)))
    this.cameras.main.setZoom(this.zoomLevel)
    this.boundCamera()
    this.centre()
  }

  /**
   * Fits the map in view at the largest whole zoom that fits (never below 1x, so a phone sees part
   * of it). The camera returns to the overview unless `keepFollow` (a resize) and the Guild Master
   * is walking.
   */
  fit(keepFollow = false): void {
    const cam = this.cameras.main
    if (!(keepFollow && this.chasing)) {
      this.chasing = false
      this.followed = null
      cam.stopFollow()
    }
    const view = this.viewport()
    const map = this.mapOf(this.viewMap)
    const world = { w: px(map.width, map.tileSize), h: px(map.height, map.tileSize) }
    this.zoomLevel =
      roomModel(this.viewMap) !== null
        ? roomZoom(view, world)
        : (keepFollow ? zoomAfterResize : integerZoom)(view.w, view.h, world.w, world.h)
    cam.setZoom(this.zoomLevel)
    this.boundCamera()
    this.centre()
  }

  /**
   * Follows a Member's sprite with the camera (null returns to the fixed overview). A Member in
   * another map of the town takes the camera there: the view switches map with them (the Guild
   * Master stays where it is, and walking brings the camera back).
   */
  follow(memberId: string | null): void {
    this.followed = memberId
    this.chasing = false
    const target = memberId ? this.memberObject(memberId) : null
    const map = memberId ? this.memberMap(memberId) : null
    if (target && map) {
      if (map !== this.viewMap) {
        this.viewMap = map
        this.frameMap()
        this.applyTint()
      }
      this.cameras.main.startFollow(target, true, 0.1, 0.1)
      this.cameras.main.centerOn(target.x, target.y)
    } else {
      this.cameras.main.stopFollow()
      this.viewMap = this.current
      this.frameMap()
      this.applyTint()
      this.centre()
    }
  }

  private centre(): void {
    if (this.followed === null) {
      const map = this.mapOf(this.viewMap)
      const { x, y } = offsetOf(this.viewMap)
      this.cameras.main.centerOn(
        x + px(map.width, map.tileSize) / 2,
        y + px(map.height, map.tileSize) / 2
      )
    }
  }

  private label(x: number, y: number, text: string, size = 16, tint = 0xffffff) {
    const t = this.add.bitmapText(x, y, FONT, text, size)
    t.setTint(tint)
    t.setDepth(DEPTH.top + 2)
    return t
  }

  private inputOn = true

  /** Turns the Hall's pointer input off (a Bag page covers it) or back on; safe before `create`. */
  setInputEnabled(enabled: boolean): void {
    this.inputOn = enabled
    if (this.input) {
      this.input.enabled = enabled
    }
  }

  /** Records whether a Council session is open and shows it at the Council table. */
  setCouncilState(state: 'idle' | 'conferring' | 'halted'): void {
    this.councilState = state
    if (this.pending && this.ready) {
      this.drawDynamic(this.pending)
    }
  }

  /** Hall signs, the Quest Board, the Seal desk, the gate and the Treasury chest: each keyed group is rebuilt only when its inputs change. */
  private drawDynamic(state: SceneState): void {
    this.dynamic.begin()
    const s = this.hall.tileSize
    const tags = roomTags(state.rooms, state.rooms.length)
    this.dynamic.group('signs', JSON.stringify([this.hallSig, tags]), () => {
      const made: Phaser.GameObjects.GameObject[] = []
      this.doors = []
      state.rooms.forEach((hall, index) => {
        const door = this.hall.doorways.find((d) => d.hallId === hall.hallId)
        const tag = tags[index]
        if (!door || !tag) {
          return
        }
        // The whole name on the sign, wrapped; locked and paused say so on a last line.
        const lines = [
          ...signLines(hall.name),
          ...(hall.locked ? ['LOCKED'] : hall.paused ? ['PAUSED'] : []),
        ]
        const x = (door.tile.x + 0.5) * s
        const bottom = (door.tile.y - 0.5) * s
        const text = this.add
          .bitmapText(x, bottom - 1, FONT, lines.join('\n'), 8)
          .setOrigin(0.5, 1)
          .setCenterAlign()
          .setTint(tag.closed ? 0xff9a8a : 0xffffff)
          .setDepth(DEPTH.top + 3)
        const plate = this.add
          .rectangle(x, bottom, text.width + 4, text.height + 3, 0x1a1a2a, 0.8)
          .setOrigin(0.5, 1)
          .setDepth(DEPTH.top + 2)
        made.push(plate, text)
        // A locked Hall's doorway is a shut door with a bar across it; a Private Hall's door looks closed until the Guild Master nears.
        if (hall.locked || hall.kind === 'private') {
          const sprite = this.add
            .image(door.tile.x * s, door.tile.y * s, DOOR)
            .setOrigin(0, 0)
            .setDepth(DEPTH.wall + 2)
          made.push(sprite)
          this.doors.push({ sprite, tile: door.tile, locked: hall.locked })
          if (hall.locked) {
            made.push(
              this.add
                .rectangle(door.tile.x * s, door.tile.y * s + 6, s, 4, 0xb8453a, 1)
                .setOrigin(0, 0)
                .setStrokeStyle(1, 0x3b2410)
                .setDepth(DEPTH.wall + 3)
            )
          }
        }
      })
      return made
    })
    const table = this.hall.pois.find((p) => p.kind === 'council-table')
    if (table) {
      this.dynamic.group('council', JSON.stringify([table.tile, this.councilState]), () => {
        const sitting = this.councilState === 'conferring'
        const halted = this.councilState === 'halted'
        const tint = halted ? 0xff6666 : sitting ? 0x99ff99 : 0xffffff
        const say = halted ? 'HALTED' : sitting ? 'IN SESSION' : 'IN RECESS'
        const zone = this.add
          .zone(table.tile.x * s, table.tile.y * s, table.tile.w * s, table.tile.h * s)
          .setOrigin(0, 0)
          .setInteractive({ useHandCursor: true })
        zone.on('pointerdown', () => this.options.onOpenCouncil?.())
        return [
          zone,
          this.label(table.tile.x * s, (table.tile.y - 1) * s, 'COUNCIL', 8),
          this.label(table.tile.x * s, table.tile.y * s + s, say, 8, tint),
        ]
      })
    }
    const board = this.hall.pois.find((p) => p.kind === 'quest-board')
    const queued = state.rooms.reduce((sum, r) => sum + (r.locked ? 0 : r.board), 0)
    if (board) {
      this.dynamic.group('board', JSON.stringify([board.tile, queued]), () => {
        const made: Phaser.GameObjects.GameObject[] = []
        const key = actorDepth((board.tile.y + board.tile.h) * s) + 1
        for (let i = 0; i < Math.min(queued, BOARD_SCROLLS); i++) {
          made.push(
            this.add
              .image(
                board.tile.x * s + 7 + (i % 2) * 14,
                board.tile.y * s - 12 + Math.floor(i / 2) * 9,
                TILES,
                FRAME.scroll
              )
              .setScale(0.5)
              .setDepth(key)
          )
        }
        if (queued > BOARD_SCROLLS) {
          made.push(
            this.label(
              (board.tile.x + 2) * s,
              (board.tile.y - 1) * s,
              `+${queued - BOARD_SCROLLS}`,
              8
            )
          )
        }
        return made
      })
    }
    const gate = this.hall.pois.find((p) => p.kind === 'gate')
    if (gate) {
      this.dynamic.group('gate', JSON.stringify([gate.tile, state.gateClosed]), () => {
        const made: Phaser.GameObjects.GameObject[] = []
        if (state.gateClosed) {
          made.push(
            this.add
              .rectangle(
                gate.tile.x * s,
                (gate.tile.y - 0.5) * s,
                gate.tile.w * s,
                1.5 * s,
                0xb8453a,
                0.4
              )
              .setOrigin(0, 0)
              .setDepth(actorDepth((gate.tile.y + gate.tile.h) * s) + 1)
          )
        }
        made.push(
          this.label(
            (gate.tile.x - 1) * s,
            (gate.tile.y - 2) * s,
            state.gateClosed ? 'GATES BARRED' : 'GATE OPEN',
            8,
            state.gateClosed ? 0xff6666 : 0x99ff99
          )
        )
        return made
      })
    }
    const seal = this.hall.pois.find((p) => p.kind === 'seal-desk')
    if (seal) {
      this.dynamic.group(
        'scrolls',
        JSON.stringify([seal.tile, state.scrolls.map((c) => c.questId)]),
        () => {
          const made: Phaser.GameObjects.GameObject[] = []
          const key = actorDepth((seal.tile.y + seal.tile.h) * s) + 1
          made.push(this.label(seal.tile.x * s, (seal.tile.y - 1) * s, 'SEALS', 8))
          state.scrolls.slice(0, MAX_SCROLLS).forEach((scroll, i) => {
            const sprite = this.add
              .image(seal.tile.x * s + 4 + i * 6, seal.tile.y * s - 2, TILES, FRAME.scroll)
              .setScale(1)
              .setDepth(key)
              .setInteractive({ useHandCursor: true })
            sprite.on('pointerdown', () => this.options.onOpenSeal(scroll.questId))
            made.push(sprite)
          })
          if (state.scrolls.length > MAX_SCROLLS) {
            made.push(
              this.label(
                (seal.tile.x + 2) * s,
                seal.tile.y * s - 6,
                `+${state.scrolls.length - MAX_SCROLLS}`,
                8
              )
            )
          }
          return made
        }
      )
    }
    const steward = this.hall.pois.find((p) => p.kind === 'steward-desk')
    if (steward) {
      this.dynamic.group('steward', JSON.stringify(steward.tile), () => [
        this.label(steward.tile.x * s, (steward.tile.y - 1) * s, 'STEWARD', 8),
      ])
    }
    // The Treasury chest: a coin and the guild's spend, on the left wall's floor row.
    this.dynamic.group('treasury-chest', JSON.stringify(formatCents(state.coinsCents)), () => [
      this.add.image(6 * s + 8, 3 * s + 8, TILES, FRAME.coin).setDepth(actorDepth(4 * s)),
      this.label(7 * s - 2, 3 * s + 3, formatCents(state.coinsCents), 8),
    ])
    this.dynamic.end()
  }

  private drawMembers(state: SceneState): void {
    const live = new Set<string>()
    // Who is free to stroll, chat or sleep: the idle Members of every Hall.
    const idleIds = Object.values(state.members)
      .filter((m) => m.status === 'idle' && !m.awaitingSeal)
      .map((m) => m.id)
    const board = this.hall.pois.find((p) => p.kind === 'quest-board')?.stand ?? this.hall.spawn
    // Each Member stands at their station in their own Hall's room.
    for (const room of state.rooms) {
      const key: MapKey = `hall:${room.hallId}`
      const model = hallRoomOf(key)
      for (const id of room.memberIds) {
        const member = state.members[id]
        if (!member || !model) {
          continue
        }
        live.add(id)
        const spot = memberSpot(model, key, id)
        this.placeMember(member, {
          home: spot,
          desk: spot,
          board: { map: 'hall', ...board },
          idleIds,
        })
      }
    }
    // The Steward stands at their desk.
    this.talkable = new Set(live)
    live.add(state.stewardId)
    const stewardSpot: Spot = { map: 'hall', ...stewardStand(this.hall) }
    this.placeMember(
      {
        id: state.stewardId,
        name: 'Steward',
        hallId: '',
        rank: 'steward',
        status: 'idle',
        questId: null,
        bubble: state.members[state.stewardId]?.bubble ?? null,
        claimSeq: null,
      },
      {
        home: stewardSpot,
        desk: stewardSpot,
        board: null,
        idleIds,
        fixed: stayAt(stewardSpot, 'steward'),
      }
    )
    for (const [id, view] of this.members) {
      if (!live.has(id)) {
        view.root.destroy()
        view.shadow.destroy()
        view.bubble?.destroy()
        this.members.delete(id)
      }
    }
  }

  /**
   * Apprentices: one small helper per in-flight Sub-Quest, walking in from its parent's seat when
   * spawned and fading out when the child settles. Reduced motion swaps them in and out.
   */
  private drawApprentices(state: SceneState): void {
    const s = this.hall.tileSize
    const live = new Set<string>()
    for (const room of state.rooms) {
      const crew = state.apprentices.filter((a) => a.hallId === room.hallId)
      const key: MapKey = `hall:${room.hallId}`
      const model = hallRoomOf(key)
      if (!model || !isRoomMapId(key) || crew.length === 0) {
        continue
      }
      const seats = apprenticeSeats(model, crew.length)
      const offset = roomOffset(key)
      crew.forEach((apprentice, n) => {
        const seat = seats[n] ?? model.spawn
        live.add(apprentice.childId)
        const x = offset.x + seat.x * s + s / 2
        const y = offset.y + seat.y * s + s / 2
        const found = this.apprentices.get(apprentice.childId)
        if (found) {
          if (!this.tweens.isTweening(found.root)) {
            found.root.setPosition(x, y)
          }
          return
        }
        const look = lookFor(apprentice.childId)
        const layers = [look.body, look.outfit, look.hair].map((frame) =>
          this.add.image(0, 0, CHARS, frame)
        )
        // The parent Quest's owner is the Member working it; the apprentice walks in from them.
        const owner = Object.values(state.members).find((m) => m.questId === apprentice.parentId)
        const ownerView = owner ? this.members.get(owner.id) : undefined
        const parent = ownerView?.walker.map === key ? ownerView.root : undefined
        const animate = !this.options.reducedMotion && !this.seeding
        const root = this.add
          .container(animate && parent ? parent.x : x, animate && parent ? parent.y : y, layers)
          .setScale(0.75)
        root.setName(`apprentice:${apprentice.childId}`)
        if (animate) {
          root.setAlpha(0)
          this.tweens.add({ targets: root, x, y, alpha: 1, duration: WALK_MS, ease: 'Linear' })
        }
        this.apprentices.set(apprentice.childId, {
          root,
          hallId: room.hallId,
          shadow: makeShadow(this),
        })
      })
    }
    for (const [id, view] of this.apprentices) {
      if (live.has(id)) {
        continue
      }
      this.apprentices.delete(id)
      this.tweens.killTweensOf(view.root)
      if (this.options.reducedMotion) {
        view.root.destroy()
        view.shadow.destroy()
      } else {
        this.tweens.add({
          targets: view.root,
          alpha: 0,
          duration: WALK_MS,
          onComplete: () => {
            view.root.destroy()
            view.shadow.destroy()
          },
        })
      }
    }
  }

  /** The apprentice's game object, by child Quest id (null when none is drawn). */
  apprenticeObject(childId: string): Phaser.GameObjects.Container | null {
    return this.apprentices.get(childId)?.root ?? null
  }

  /** The routine slot of the in-game time: ten minutes each, from the clock unless forced. */
  private routineSlot(): number {
    if (this.slotForced !== null) {
      return this.slotForced
    }
    const now = new Date()
    return now.getHours() * 6 + Math.floor(now.getMinutes() / 10)
  }

  /** Forces the routine slot (QA: `?slot=`); null follows the clock. */
  setSlot(slot: number | null): void {
    this.slotForced = slot
    if (this.pending && this.ready) {
      this.drawMembers(this.pending)
    }
  }

  /** The walkable test of any map for a walking Member (the hall's keeps closed rooms shut). */
  private readonly walkableOf = (map: MapKey): ((x: number, y: number) => boolean) =>
    mapData(map).walkable

  /**
   * Plans what a Member should be doing (a pure function of state, seed and time) and, when the
   * plan changes, starts them walking it. Reduced motion and the first draw swap positions.
   */
  private placeMember(
    member: SceneMember,
    where: { home: Spot; desk: Spot; board: Spot | null; idleIds: readonly string[]; fixed?: Plan }
  ): void {
    let view = this.members.get(member.id)
    if (!view) {
      const look = lookFor(member.id, member.look)
      const layers = [look.body, look.outfit, look.hair].map((frame) =>
        this.add.image(0, 0, CHARS, frame)
      )
      const scroll = this.add.image(7, -6, TILES, FRAME.scroll).setScale(0.5).setVisible(false)
      scroll.setName('badge')
      const sleep = this.add.bitmapText(2, -14, FONT, 'Zz', 16).setTint(0xffffff).setVisible(false)
      sleep.setScale(0.5)
      const root = this.add.container(0, 0, [...layers, scroll, sleep])
      root.setName(member.id)
      root.setSize(16, 16)
      root.setInteractive({ useHandCursor: true })
      root.on('pointerdown', () => this.options.onInspect?.(member.id))
      view = {
        root,
        bubble: null,
        bubbleTimer: null,
        bubbleSeq: member.bubble?.seq ?? 0,
        claimSeq: member.claimSeq ?? 0,
        walker: standing(where.home, 'new'),
        handedSeq: member.doneSeq ?? 0,
        handingSeq: 0,
        spoken: 0,
        name: member.name,
        scroll,
        sleep,
        shadow: makeShadow(this),
      }
      this.members.set(member.id, view)
      this.syncMember(view)
    }
    const done = member.doneSeq ?? 0
    if (done < view.handedSeq) {
      // Scrubbing back past a hand-in lets the same finished Quest be handed in again.
      view.handedSeq = done
    }
    const handIn = done > view.handedSeq
    const plan =
      where.fixed ??
      planFor({
        seed: this.options.seed ?? '',
        member,
        home: where.home,
        desk: where.desk,
        phase: this.phase,
        slot: this.routineSlot(),
        idleIds: where.idleIds,
        handIn,
      })
    const claimed = member.claimSeq !== null && member.claimSeq > view.claimSeq
    view.claimSeq = member.claimSeq ?? 0
    const instant = this.options.reducedMotion || this.seeding
    if (plan.key !== view.walker.planKey) {
      // A new claim walks the Member to their Hall's Quest Board first.
      const stops =
        claimed && where.board && !instant
          ? [
              {
                spot: where.board,
                anim: 'idle' as const,
                dwellMs: 0,
                hidden: false,
                carry: null,
                line: null,
              },
              ...plan.stops,
            ]
          : plan.stops
      view.handingSeq = handIn ? done : 0
      view.walker = replan(
        view.walker,
        { key: plan.key, stops },
        this.time.now,
        this.walkableOf,
        instant
      )
      this.syncMember(view)
    }
    // The addressee of a cross-Hall Missive speaks once the courier has arrived.
    const awaiting =
      member.bubble !== null && this.walkingCouriers.get(member.bubble.seq) === member.id
    this.showBubble(view, awaiting ? null : member.bubble, view.root.x, view.root.y)
  }

  /** Puts the Member's game object where their walker is: map, tile, scroll and sleep mark. */
  private syncMember(view: MemberView): void {
    const { walker } = view
    const s = this.hall.tileSize
    const { x: ox, y: oy } = offsetOf(walker.map)
    const spot = { x: Math.round(ox + walker.pos.x * s), y: Math.round(oy + walker.pos.y * s) }
    // Never stand on the Guild Master: step aside when sharing their map and tile.
    const gm = this.player
    const to = gm && walker.map === this.current ? stepAside(spot, { x: gm.x, y: gm.y }) : spot
    view.root.setPosition(to.x, to.y)
    view.root.setVisible(!walker.hidden)
    view.scroll.setVisible(walker.carry === 'scroll' || walker.anim === 'handin')
    view.sleep.setVisible(walker.anim === 'sleep')
    view.root.setData('map', walker.map)
    view.root.setData('anim', walker.anim)
  }

  /** Per frame: every Member steps along their plan; arrivals speak, hand-ins ring out. */
  private stepMembers(seconds: number): void {
    for (const view of this.members.values()) {
      const before = view.walker
      view.walker = stepWalker(before, seconds, this.time.now, this.walkableOf)
      const { walker } = view
      if (walker.line !== null && walker.arrivals !== view.spoken) {
        view.spoken = walker.arrivals
        this.showBubble(
          view,
          { text: walker.line, seq: -walker.arrivals },
          view.root.x,
          view.root.y
        )
      }
      if (walker.handedIn && !before.handedIn && view.handingSeq > view.handedSeq) {
        view.handedSeq = view.handingSeq
        this.options.onHandIn?.(view.name)
      }
      this.syncMember(view)
    }
    // A followed Member who walks into another map takes the camera with them.
    const followed = this.followed
    if (followed !== null && followed !== GUILD_MASTER) {
      const there = this.memberMap(followed)
      if (there !== null && there !== this.viewMap) {
        this.follow(followed)
      }
    }
    // Run-check hooks: the map the camera shows, and where every Member is (map, tile, doing what).
    this.game.canvas.dataset.view = this.viewMap
    this.game.canvas.dataset.player = `${this.current}:${Math.floor(this.at.x)},${Math.floor(this.at.y)}`
    const view = this.cameras.main.worldView
    this.game.canvas.dataset.camera = `${Math.round(view.x)},${Math.round(view.y)},${this.cameras.main.zoom}`
    this.game.canvas.dataset.members = [...this.members]
      .map(
        ([id, v]) =>
          `${id}:${v.walker.map}:${Math.floor(v.walker.pos.x)},${Math.floor(v.walker.pos.y)}:${v.walker.anim}${v.walker.hidden ? ':hidden' : ''}`
      )
      .join(';')
  }

  /** The map a Member is in (null when none is drawn): Members are tracked on every map. */
  memberMap(id: string): MapKey | null {
    return this.members.get(id)?.walker.map ?? null
  }

  private showBubble(view: MemberView, bubble: SceneBubble | null, x: number, y: number): void {
    if (!bubble) {
      // Scrubbing back past a bubble lets the same event speak again when replayed forward.
      view.bubbleSeq = 0
      return
    }
    if (bubble.seq === view.bubbleSeq) {
      return
    }
    view.bubbleSeq = bubble.seq
    view.bubble?.destroy()
    view.bubbleTimer?.remove()
    const text =
      bubble.text.length > BUBBLE_CHARS ? `${bubble.text.slice(0, BUBBLE_CHARS - 1)}~` : bubble.text
    const label = this.add
      .bitmapText(0, 0, FONT, text, 16)
      .setTint(0x1a1a2a)
      .setOrigin(0.5, 0.5)
      .setMaxWidth(BUBBLE_WRAP)
      .setCenterAlign()
    const w = label.width + 8
    const h = label.height + 4
    const back = this.add.rectangle(0, 0, w, h, 0xffffff, 1).setStrokeStyle(1, 0x1a1a2a)
    const root = this.add.container(x, y, [back, label]).setDepth(30)
    // The bubble rides with the sprite (a Member walking to the Quest Board), so `update` places it.
    root.setData('height', h)
    root.setData('width', w)
    view.bubble = root
    view.bubbleTimer = this.time.delayedCall(BUBBLE_MS, () => {
      root.destroy()
      if (view.bubble === root) {
        view.bubble = null
      }
    })
  }
}
