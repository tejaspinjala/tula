import Phaser from 'phaser'
import { formatCents } from '../treasury'
import hallMap from './hall.tiled.json'
import { nearestTarget, REACH, sameTarget, type Target } from './interact'
import {
  bubbleCentreY,
  fitZoom,
  type HallLayout,
  hallLayout,
  openZoom,
  seatsIn,
  withClosedDoors,
} from './layout'
import { framesOf, GUILD_MASTER_ID, type LookChoice, lookFor } from './look'
import type { SceneMember, SceneState } from './scene'
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

/** Texture keys of the loaded art. */
const TILES = 'tiles'
const CHARS = 'chars'
const FONT = 'font'
const MAP = 'hall'

/** Tile frames of the Kenney Roguelike/RPG sheet (row * 57 + column). */
const FRAME = { doorClosed: 32, doorOpen: 37, scroll: 899, coin: 1025 } as const

/** How long a speech bubble stays up, in ms. */
const BUBBLE_MS = 4500
/** Longest Quest title a bubble shows before it is cut. */
const BUBBLE_CHARS = 24
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
  /** Called when the Guild Master presses E: talk to whoever is in reach. */
  onInteract: () => void
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
  mode: 'idle' | 'working' | null
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
  private baselineSeq: number | null = null
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
    this.cache.tilemap.add(MAP, { format: Phaser.Tilemaps.Formats.TILED_JSON, data: hallMap })
    const map = this.make.tilemap({ key: MAP })
    const tileset = map.addTilesetImage('roguelike', TILES, 16, 16, 0, 1)
    if (tileset) {
      for (const name of ['floor', 'walls', 'furniture']) {
        map.createLayer(name, tileset, 0, 0)
      }
      // The collision layer is kept (hidden) so a walkable player can use it later.
      const collision = map.createLayer('collision', tileset, 0, 0)
      collision?.setVisible(false)
      collision?.setCollisionByExclusion([-1])
    }
    this.drawFixtures()
    // Refit only when the canvas really changed size: Phaser also emits `resize` after a zoom.
    let size = `${this.scale.width}x${this.scale.height}`
    this.scale.on('resize', () => {
      const next = `${this.scale.width}x${this.scale.height}`
      if (next !== size) {
        size = next
        this.fit(true)
      }
    })
    // The camera never shows past the hall: a small hall is centred, not dragged into the void.
    this.cameras.main.setBounds(
      0,
      0,
      px(this.layout.width, this.layout.tileSize),
      px(this.layout.height, this.layout.tileSize)
    )
    this.createPlayer()
    this.ready = true
    this.fit()
    this.openReadable()
    if (this.pending) {
      this.render(this.pending)
    }
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
    this.syncPlayer()
    this.chase(true)
  }

  /** Per frame: held keys walk the Guild Master, otherwise a tapped path is followed. */
  override update(_time: number, delta: number): void {
    if (!this.player) {
      return
    }
    const seconds = Math.min(delta, 100) / 1000
    const dir = direction(this.keys)
    if (dir.x !== 0 || dir.y !== 0) {
      this.path = []
      this.at = moveBy(this.at, dir.x * SPEED * seconds, dir.y * SPEED * seconds, this.walkable)
      this.chase(false)
    } else if (this.path.length > 0) {
      const next = followPath(this.at, this.path, SPEED * seconds)
      this.at = next.pos
      this.path = next.path
      this.chase(false)
    }
    this.syncPlayer()
    this.updateNear()
  }

  /** Reports who is in reach (a Member, or the Seal desk) whenever that changes. */
  private updateNear(): void {
    const s = this.layout.tileSize
    const targets: { target: Target; at: Vec }[] = []
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
      const to = { x: Math.floor(pointer.worldX / s), y: Math.floor(pointer.worldY / s) }
      const from = { x: Math.floor(this.at.x), y: Math.floor(this.at.y) }
      const route = findPath(this.walkable, from, to)
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
    this.player?.setPosition(this.at.x * s, this.at.y * s)
    const now = roomAt(this.layout.rooms, this.at)
    if (now !== this.room) {
      this.room = now
      this.options.onRoom(now)
    }
  }

  /** Follows the Guild Master with the camera: no easing under reduced motion. */
  private chase(snap: boolean): void {
    const cam = this.cameras.main
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
    if (this.baselineSeq === null) {
      this.baselineSeq = state.appliedSeq
    }
    this.walkable = withClosedDoors(this.layout, state.rooms)
    this.lockedSlots = new Set(state.rooms.flatMap((r, i) => (r.locked ? [i] : [])))
    this.drawDynamic(state)
    this.drawMembers(state)
  }

  /** Zooms the camera by a step (clamped), keeping the hall centred. */
  zoomBy(step: number): void {
    this.zoomLevel = Math.min(4, Math.max(0.25, this.zoomLevel + step))
    this.cameras.main.setZoom(this.zoomLevel)
    this.centre()
  }

  /**
   * Fits the whole hall in view: the largest whole zoom that fits, or a half step on a phone. The
   * camera returns to the overview unless `keepFollow` (a resize) and the Guild Master is walking.
   */
  fit(keepFollow = false): void {
    const cam = this.cameras.main
    if (!(keepFollow && this.chasing)) {
      this.chasing = false
      this.followed = null
      cam.stopFollow()
    }
    cam.setSize(this.scale.width, this.scale.height)
    const worldW = px(this.layout.width, this.layout.tileSize)
    const worldH = px(this.layout.height, this.layout.tileSize)
    this.zoomLevel = fitZoom(this.scale.width, this.scale.height, worldW, worldH)
    if (keepFollow && this.chasing) {
      this.zoomLevel = Math.max(1, this.zoomLevel)
    }
    cam.setZoom(this.zoomLevel)
    this.centre()
  }

  /** A phone opens at a readable zoom on the Guild Master, not at the whole hall in miniature; Fit hall still shows it all. */
  private openReadable(): void {
    const cam = this.cameras.main
    const worldW = px(this.layout.width, this.layout.tileSize)
    const worldH = px(this.layout.height, this.layout.tileSize)
    const zoom = openZoom(this.scale.width, this.scale.height, worldW, worldH)
    if (zoom > this.zoomLevel) {
      this.zoomLevel = zoom
      cam.setZoom(zoom)
      cam.centerOn(this.at.x * this.layout.tileSize, this.at.y * this.layout.tileSize)
    }
  }

  /** Follows a Member's sprite with the camera (null returns to the fixed overview). */
  follow(memberId: string | null): void {
    this.followed = memberId
    this.chasing = false
    const target = memberId ? this.memberObject(memberId) : null
    if (target) {
      this.cameras.main.startFollow(target, true, 0.1, 0.1)
    } else {
      this.cameras.main.stopFollow()
      this.centre()
    }
  }

  private centre(): void {
    if (this.followed === null) {
      this.cameras.main.centerOn(
        px(this.layout.width, this.layout.tileSize) / 2,
        px(this.layout.height, this.layout.tileSize) / 2
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
    const s = this.layout.tileSize
    const live = new Set<string>()
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
        const work = {
          x: slot.x + 1 + (n % Math.max(1, slot.w - 2)),
          y: slot.y + 2,
        }
        this.placeMember(member, member.status === 'working' ? work : seat, s)
      })
    })
    // The Steward sits at their desk.
    const stew = this.layout.stewardDesk
    this.talkable = new Set(live)
    live.add(state.stewardId)
    this.placeMember(
      {
        id: state.stewardId,
        name: 'Steward',
        hallId: '',
        rank: 'steward',
        status: 'idle',
        questId: null,
        bubble: null,
      },
      { x: stew.x + 1, y: stew.y + stew.h },
      s
    )
    for (const [id, view] of this.members) {
      if (!live.has(id)) {
        view.root.destroy()
        view.bubble?.destroy()
        this.members.delete(id)
      }
    }
  }

  private placeMember(member: SceneMember, tile: { x: number; y: number }, s: number): void {
    let view = this.members.get(member.id)
    const x = tile.x * s + s / 2
    const y = tile.y * s + s / 2
    if (!view) {
      const look = lookFor(member.id, member.look)
      const layers = [look.body, look.outfit, look.hair].map((frame) =>
        this.add.image(0, 0, CHARS, frame)
      )
      const root = this.add.container(x, y, layers).setDepth(15)
      root.setName(member.id)
      view = { root, bubble: null, bubbleTimer: null, bubbleSeq: 0, mode: null }
      this.members.set(member.id, view)
      root.setPosition(x, y)
    } else if (view.root.x !== x || view.root.y !== y) {
      if (this.options.reducedMotion) {
        view.root.setPosition(x, y)
      } else {
        this.tweens.killTweensOf(view.root)
        this.tweens.add({ targets: view.root, x, y, duration: 700, ease: 'Linear' })
      }
    }
    if (view.mode !== member.status) {
      view.mode = member.status
      view.root.setAlpha(1)
    }
    this.showBubble(member, view, x, y)
  }

  private showBubble(member: SceneMember, view: MemberView, x: number, y: number): void {
    const bubble = member.bubble
    if (!bubble || bubble.seq <= view.bubbleSeq || bubble.seq <= (this.baselineSeq ?? 0)) {
      return
    }
    view.bubbleSeq = bubble.seq
    view.bubble?.destroy()
    view.bubbleTimer?.remove()
    const text =
      bubble.text.length > BUBBLE_CHARS ? `${bubble.text.slice(0, BUBBLE_CHARS - 1)}~` : bubble.text
    const label = this.add.bitmapText(0, 0, FONT, text, 16).setTint(0x1a1a2a).setOrigin(0.5, 0.5)
    const w = label.width + 8
    const back = this.add.rectangle(0, 0, w, 20, 0xffffff, 1).setStrokeStyle(1, 0x1a1a2a)
    const root = this.add
      .container(x, bubbleCentreY(this.layout.rooms, this.layout.tileSize, x, y), [back, label])
      .setDepth(30)
    view.bubble = root
    view.bubbleTimer = this.time.delayedCall(BUBBLE_MS, () => {
      root.destroy()
      if (view.bubble === root) {
        view.bubble = null
      }
    })
  }
}
