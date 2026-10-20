import Phaser from 'phaser'
import { formatCents } from '../treasury'
import { stepAside } from './aside'
import { type Plan, planFor, stayAt } from './behavior'
import { integerZoom, openZoomWhole, type Phase, phaseAt, tintFor, walkPose } from './daylight'
import { nearestTarget, REACH, sameTarget, type Target } from './interact'
import {
  apprenticeSeats,
  bubbleCentreY,
  type HallLayout,
  hallLayout,
  questBoardIn,
  seatsIn,
  withClosedDoors,
} from './layout'
import { framesOf, GUILD_MASTER_ID, type LookChoice, lookFor } from './look'
import type { Spot } from './route'
import type { SceneBubble, SceneMember, SceneState } from './scene'
import {
  direction,
  findPath,
  followPath,
  type Keys,
  moveBy,
  roomAt,
  SPEED,
  teleportTile,
  type Vec,
} from './walk'
import { replan, standing, stepWalker, type Walker } from './walker'
import {
  doorAt,
  MAP_IDS,
  type MapId,
  mapData,
  mapSource,
  type PlaceName,
  placeNamed,
} from './world'

/** Texture keys of the loaded art. */
const TILES = 'tiles'
const CHARS = 'chars'
const FONT = 'font'
const GLOW = 'glow'
/** Where each map sits in the one Phaser world, in px: far apart so a camera sees only one. */
const OFFSETS: Record<MapId, Vec> = {
  hall: { x: 0, y: 0 },
  plaza: { x: 0, y: 2000 },
  archive: { x: 0, y: 4000 },
  vault: { x: 0, y: 6000 },
  trail: { x: 0, y: 8000 },
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
  vault: [{ text: 'TREASURY', x: 5, y: 3 }],
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
  /** Called when the Guild Master enters a room (its slot) or leaves to the hallway (null). */
  onRoom: (slot: number | null) => void
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
  onMap?: ((map: MapId) => void) | undefined
}

/** Where the Guild Master enters the hall: just inside the gate, in tiles. */
const ENTRANCE: Vec = { x: 38.5, y: 12.5 }
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
}

/** An apprentice: a Sub-Quest's helper standing in its parent's room until the child settles. */
interface ApprenticeView {
  root: Phaser.GameObjects.Container
  hallId: string
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
  private readonly layout: HallLayout = hallLayout()
  /** The map's walkable test with the doors of locked and empty rooms closed; refreshed on every render. */
  private walkable: (x: number, y: number) => boolean = this.layout.walkable
  private lockedSlots = new Set<number>()
  private readonly options: HallOptions
  private readonly members = new Map<string, MemberView>()
  private dynamic: Phaser.GameObjects.GameObject[] = []
  private pending: SceneState | null = null
  private ready = false
  private readonly apprentices = new Map<string, ApprenticeView>()
  /** True until the first state is drawn: what already happened is shown, not animated. */
  private seeding = true
  private gateSprites: Phaser.GameObjects.Image[] = []
  private zoomLevel = 1
  private followed: string | null = null
  private player: Phaser.GameObjects.Container | null = null
  private playerLayers: Phaser.GameObjects.Image[] = []
  private playerLook: LookChoice | null = null
  private at: Vec = { ...ENTRANCE }
  private path: Vec[] = []
  private chasing = false
  private room: number | null = null
  /** The map of the town the Guild Master is in. */
  private current: MapId = 'hall'
  /** The map the camera shows: the Guild Master's, unless the camera follows a Member elsewhere. */
  private viewMap: MapId = 'hall'
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
  }

  create(): void {
    for (const id of MAP_IDS) {
      this.drawMap(id)
    }
    this.drawFixtures()
    this.makeGlow()
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
      .setDepth(18)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
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

  /** Moves the Guild Master to the middle of a room (slot) or back to the entrance (null). */
  teleport(slot: number | null): void {
    if (slot !== null && this.lockedSlots.has(slot)) {
      return
    }
    const tile = slot === null ? null : teleportTile(this.layout.rooms, slot, this.walkable)
    this.at = tile ? { x: tile.x + 0.5, y: tile.y + 0.5 } : { ...ENTRANCE }
    this.path = []
    this.chasing = true
    if (this.current !== 'hall') {
      this.enter('hall', this.at)
      return
    }
    this.syncPlayer()
    this.chase(true)
  }

  /** Walks the Guild Master to a named place in whatever map it is in (a point for behaviour code to target). */
  goTo(name: PlaceName): void {
    const place = placeNamed(name)
    this.enter(place.map, { x: place.stand.x + 0.5, y: place.stand.y + 0.5 })
  }

  /** The map of the town the Guild Master is in. */
  currentMap(): MapId {
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
  private enter(id: MapId, at: Vec): void {
    this.current = id
    this.viewMap = id
    this.at = { ...at }
    this.path = []
    this.releaseKeys()
    this.frameMap()
    this.applyTint()
    this.syncPlayer()
    this.chase(true)
    this.options.onMap?.(id)
  }

  /** Bounds the camera to the current map, opens at a whole zoom and centres on the Guild Master. */
  private frameMap(): void {
    const cam = this.cameras.main
    const { x, y } = OFFSETS[this.viewMap]
    const map = mapData(this.viewMap)
    const w = px(map.width, map.tileSize)
    const h = px(map.height, map.tileSize)
    cam.setSize(this.scale.width, this.scale.height)
    this.zoomLevel = openZoomWhole(this.scale.width, this.scale.height, w, h)
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
    const { x, y } = OFFSETS[this.viewMap]
    const map = mapData(this.viewMap)
    const w = px(map.width, map.tileSize)
    const h = px(map.height, map.tileSize)
    const boundW = Math.max(w, cam.width / cam.zoom)
    const boundH = Math.max(h, cam.height / cam.zoom)
    cam.setBounds(x - (boundW - w) / 2, y - (boundH - h) / 2, boundW, boundH)
  }

  /** Lays the world tint over the current map only, and lights or douses its lanterns. */
  private applyTint(): void {
    // Before the scene has loaded there is nothing to tint: `create` applies the stored phase.
    if (!this.veil) {
      return
    }
    const tint = tintFor(this.phase)
    const { x, y } = OFFSETS[this.viewMap]
    const map = mapData(this.viewMap)
    this.veil
      .setPosition(x, y)
      .setSize(px(map.width, map.tileSize), px(map.height, map.tileSize))
      .setFillStyle(tint.color, tint.alpha)
    for (const lantern of this.lanterns) {
      lantern.destroy()
    }
    this.lanterns = []
    if (!tint.lanterns) {
      return
    }
    for (const lantern of map.lanterns) {
      this.lanterns.push(
        this.add
          .image(x + (lantern.x + 0.5) * map.tileSize, y + (lantern.y + 0.5) * map.tileSize, GLOW)
          .setDepth(19)
          .setBlendMode(Phaser.BlendModes.ADD)
      )
    }
  }

  /** One of the town's maps as tile layers at its offset; the collision layer stays hidden. */
  private drawMap(id: MapId): void {
    const key = `map-${id}`
    this.cache.tilemap.add(key, { format: Phaser.Tilemaps.Formats.TILED_JSON, data: mapSource(id) })
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
    for (const view of this.members.values()) {
      const height = view.bubble?.getData('height')
      if (view.bubble && typeof height === 'number') {
        // Above the speaker, or below when that would cover a room label; a tall (wrapped) bubble
        // moves away from the speaker by its extra height.
        const { x, y } = view.root
        const centre = bubbleCentreY(this.layout.rooms, this.layout.tileSize, x, y)
        const extra = (height - 20) / 2
        view.bubble.setPosition(x, centre < y ? centre - extra : centre + extra)
      }
    }
    this.stepMembers(Math.min(delta, 100) / 1000)
    if (!this.player) {
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
    const door = doorAt(mapData(this.current), Math.floor(this.at.x), Math.floor(this.at.y))
    if (door) {
      this.enter(door.to, { x: door.toX + 0.5, y: door.toY + 0.5 })
      return
    }
    this.syncPlayer()
    this.updateNear()
  }

  /** The walkable test of the map the Guild Master is in (the hall's has closed doors shut). */
  private canWalk(): (x: number, y: number) => boolean {
    return this.current === 'hall' ? this.walkable : mapData(this.current).walkable
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

  /** Reports who is in reach (a Member, or the Seal desk) whenever that changes. */
  private updateNear(): void {
    const s = this.layout.tileSize
    const targets: { target: Target; at: Vec }[] = []
    if (this.current !== 'hall') {
      if (this.near !== null) {
        this.near = null
        this.options.onNear(null)
      }
      return
    }
    for (const id of this.talkable) {
      const root = this.members.get(id)?.root
      if (root) {
        targets.push({ target: { kind: 'member', id }, at: { x: root.x / s, y: root.y / s } })
      }
    }
    // The desk is a rectangle: reach its nearest edge, not its middle.
    const desk = this.layout.sealDesk
    targets.push({
      target: { kind: 'sealDesk' },
      at: {
        x: Math.min(desk.x + desk.w - 0.5, Math.max(desk.x + 0.5, this.at.x)),
        y: Math.min(desk.y + desk.h - 0.5, Math.max(desk.y + 0.5, this.at.y)),
      },
    })
    const now = nearestTarget(this.at, targets, REACH)
    if (!sameTarget(now, this.near)) {
      this.near = now
      this.options.onNear(now)
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
    this.player = this.add.container(0, 0, layers).setDepth(16)
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
      const s = this.layout.tileSize
      const { x: ox, y: oy } = OFFSETS[this.current]
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

  /** Puts the sprite on the Guild Master's position and reports a change of room. */
  private syncPlayer(): void {
    const s = this.layout.tileSize
    const { x: ox, y: oy } = OFFSETS[this.current]
    this.player?.setPosition(ox + this.at.x * s, oy + this.at.y * s)
    const now = this.current === 'hall' ? roomAt(this.layout.rooms, this.at) : null
    if (now !== this.room) {
      this.room = now
      this.options.onRoom(now)
    }
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
    this.walkable = withClosedDoors(this.layout, state.rooms)
    this.lockedSlots = new Set(state.rooms.flatMap((r, i) => (r.locked ? [i] : [])))
    this.drawDynamic(state)
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
    cam.setSize(this.scale.width, this.scale.height)
    const map = mapData(this.viewMap)
    this.zoomLevel = integerZoom(
      this.scale.width,
      this.scale.height,
      px(map.width, map.tileSize),
      px(map.height, map.tileSize)
    )
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
      const map = mapData(this.viewMap)
      const { x, y } = OFFSETS[this.viewMap]
      this.cameras.main.centerOn(
        x + px(map.width, map.tileSize) / 2,
        y + px(map.height, map.tileSize) / 2
      )
    }
  }

  private label(x: number, y: number, text: string, size = 16, tint = 0xffffff) {
    const t = this.add.bitmapText(x, y, FONT, text, size)
    t.setTint(tint)
    t.setDepth(20)
    return t
  }

  private drawFixtures(): void {
    const s = this.layout.tileSize
    const stew = this.layout.stewardDesk
    this.label(stew.x * s, (stew.y - 0.6) * s, 'STEWARD')
    const seal = this.layout.sealDesk
    this.label(seal.x * s, (seal.y - 0.6) * s, 'SEALS')
    const coins = this.layout.coins
    this.add.image(coins.x * s + 8, coins.y * s + 8, TILES, FRAME.coin).setDepth(5)
  }

  /** Rooms, gate, scrolls and the coin counter: redrawn whenever the state changes. */
  private drawDynamic(state: SceneState): void {
    for (const object of this.dynamic) {
      object.destroy()
    }
    this.dynamic = []
    this.gateSprites = []
    const add = <T extends Phaser.GameObjects.GameObject>(object: T): T => {
      this.dynamic.push(object)
      return object
    }
    const s = this.layout.tileSize
    this.layout.rooms.forEach((room, index) => {
      const hall = state.rooms[index]
      const door = this.layout.doorways[index]
      const veil = hall ? (hall.locked ? 0.6 : hall.paused ? 0.35 : 0) : 0.75
      if (veil > 0) {
        add(
          this.add
            .rectangle(room.x * s, room.y * s, room.w * s, room.h * s, 0x101018, veil)
            .setOrigin(0, 0)
            .setDepth(10)
        )
      }
      if (hall) {
        const tag = hall.locked
          ? `${hall.name} (locked)`
          : hall.paused
            ? `${hall.name} (paused)`
            : hall.name
        add(this.label(room.x * s + 4, room.y * s + 2, tag.slice(0, 22), 16))
      }
      if (hall && !hall.locked) {
        // The Quest Board: a board tile with a scroll per Quest posted (a team Campaign fills it).
        const spot = questBoardIn(this.layout, room)
        add(
          this.add
            .rectangle(spot.x * s + 8, spot.y * s + 8, s, s, 0x7a4b24, 1)
            .setStrokeStyle(1, 0x3b2410)
            .setDepth(4)
        )
        const shown = Math.min(hall.board, BOARD_SCROLLS)
        for (let i = 0; i < shown; i++) {
          add(
            this.add
              .image(
                spot.x * s + 3 + (i % 2) * 7,
                spot.y * s + 4 + Math.floor(i / 2) * 7,
                TILES,
                FRAME.scroll
              )
              .setScale(0.45)
              .setDepth(5)
          )
        }
        if (hall.board > BOARD_SCROLLS) {
          add(this.label((spot.x + 1) * s + 2, spot.y * s + 2, `+${hall.board - BOARD_SCROLLS}`))
        }
      }
      if (door && (!hall || hall.locked)) {
        for (let dx = 0; dx < door.w; dx++) {
          add(
            this.add
              .image((door.x + dx) * s + 8, door.y * s + 8, TILES, FRAME.doorClosed)
              .setDepth(11)
          )
        }
      }
    })
    const gate = this.layout.gate
    for (let dy = 0; dy < gate.h; dy++) {
      const image = add(
        this.add
          .image(
            gate.x * s + 8,
            (gate.y + dy) * s + 8,
            TILES,
            state.gateClosed ? FRAME.doorClosed : FRAME.doorOpen
          )
          .setDepth(11)
      )
      if (state.gateClosed) {
        image.setTint(0xff5555)
      }
      this.gateSprites.push(image)
    }
    add(
      this.label(
        (gate.x - 5) * s,
        (gate.y + gate.h + 0.2) * s,
        state.gateClosed ? 'GATES BARRED' : 'GATE OPEN',
        16,
        state.gateClosed ? 0xff6666 : 0x99ff99
      )
    )
    const seal = this.layout.sealDesk
    state.scrolls.slice(0, MAX_SCROLLS).forEach((scroll, i) => {
      const scrollSprite = add(
        this.add
          .image((seal.x + i) * s + 8, seal.y * s + 8, TILES, FRAME.scroll)

          .setScale(1.5)
          .setDepth(12)
          .setInteractive({ useHandCursor: true })
      )
      scrollSprite.on('pointerdown', () => this.options.onOpenSeal(scroll.questId))
    })
    if (state.scrolls.length > MAX_SCROLLS) {
      add(
        this.label(
          (seal.x + MAX_SCROLLS) * s,
          seal.y * s + 4,
          `+${state.scrolls.length - MAX_SCROLLS}`
        )
      )
    }
    const coins = this.layout.coins
    add(this.label((coins.x + 1.2) * s, coins.y * s + 3, formatCents(state.coinsCents)))
  }

  private drawMembers(state: SceneState): void {
    const live = new Set<string>()
    // Who is free to stroll, chat or sleep: the idle Members of every Hall.
    const idleIds = Object.values(state.members)
      .filter((m) => m.status === 'idle' && !m.awaitingSeal)
      .map((m) => m.id)
    state.rooms.forEach((room, index) => {
      const slot = this.layout.rooms[index]
      if (!slot) {
        return
      }
      const seats = seatsIn(this.layout, slot, room.memberIds.length)
      room.memberIds.forEach((id, n) => {
        const member = state.members[id]
        const seat = seats[n]
        if (!member || !seat) {
          return
        }
        live.add(id)
        const desk = {
          x: slot.x + 1 + (n % Math.max(1, slot.w - 2)),
          y: slot.y + 2,
        }
        const board = questBoardIn(this.layout, slot)
        this.placeMember(member, {
          home: { map: 'hall', ...seat },
          desk: { map: 'hall', ...desk },
          board: { map: 'hall', ...board },
          idleIds,
        })
      })
    })
    // The Steward sits at their desk.
    const stew = this.layout.stewardDesk
    this.talkable = new Set(live)
    live.add(state.stewardId)
    const stewardSpot: Spot = { map: 'hall', x: stew.x + 1, y: stew.y + stew.h }
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
    const s = this.layout.tileSize
    const live = new Set<string>()
    state.rooms.forEach((room, index) => {
      const slot = this.layout.rooms[index]
      const crew = state.apprentices.filter((a) => a.hallId === room.hallId)
      if (!slot || crew.length === 0) {
        return
      }
      const seats = apprenticeSeats(this.layout, slot, crew.length)
      crew.forEach((apprentice, n) => {
        const seat = seats[n]
        if (!seat) {
          return
        }
        live.add(apprentice.childId)
        const x = seat.x * s + s / 2
        const y = seat.y * s + s / 2
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
        const parent = ownerView?.walker.map === 'hall' ? ownerView.root : undefined
        const animate = !this.options.reducedMotion && !this.seeding
        const root = this.add
          .container(animate && parent ? parent.x : x, animate && parent ? parent.y : y, layers)
          .setScale(0.75)
          .setDepth(14)
        root.setName(`apprentice:${apprentice.childId}`)
        if (animate) {
          root.setAlpha(0)
          this.tweens.add({ targets: root, x, y, alpha: 1, duration: WALK_MS, ease: 'Linear' })
        }
        this.apprentices.set(apprentice.childId, { root, hallId: room.hallId })
      })
    })
    for (const [id, view] of this.apprentices) {
      if (live.has(id)) {
        continue
      }
      this.apprentices.delete(id)
      this.tweens.killTweensOf(view.root)
      if (this.options.reducedMotion) {
        view.root.destroy()
      } else {
        this.tweens.add({
          targets: view.root,
          alpha: 0,
          duration: WALK_MS,
          onComplete: () => view.root.destroy(),
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
  private readonly walkableOf = (map: MapId): ((x: number, y: number) => boolean) =>
    map === 'hall' ? this.walkable : mapData(map).walkable

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
      const root = this.add.container(0, 0, [...layers, scroll, sleep]).setDepth(15)
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
    this.showBubble(view, member.bubble, view.root.x, view.root.y)
  }

  /** Puts the Member's game object where their walker is: map, tile, scroll and sleep mark. */
  private syncMember(view: MemberView): void {
    const { walker } = view
    const s = this.layout.tileSize
    const { x: ox, y: oy } = OFFSETS[walker.map]
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
    this.game.canvas.dataset.members = [...this.members]
      .map(
        ([id, v]) =>
          `${id}:${v.walker.map}:${Math.floor(v.walker.pos.x)},${Math.floor(v.walker.pos.y)}:${v.walker.anim}${v.walker.hidden ? ':hidden' : ''}`
      )
      .join(';')
  }

  /** The map a Member is in (null when none is drawn): Members are tracked on every map. */
  memberMap(id: string): MapId | null {
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
    view.bubble = root
    view.bubbleTimer = this.time.delayedCall(BUBBLE_MS, () => {
      root.destroy()
      if (view.bubble === root) {
        view.bubble = null
      }
    })
  }
}
