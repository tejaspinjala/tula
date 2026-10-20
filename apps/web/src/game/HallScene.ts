import Phaser from 'phaser'
import { formatCents } from '../treasury'
import hallMap from './hall.tiled.json'
import { nearestTarget, REACH, sameTarget, type Target } from './interact'
import { apprenticeSeats, type HallLayout, hallLayout, questBoardIn, seatsIn } from './layout'
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
  /** The last claim seq acted on, so a claim walks to the Quest Board once. */
  claimSeq: number
  /** Where the sprite is headed (px), so a repeated render does not restart its walk. */
  tx: number
  ty: number
  mode: 'idle' | 'working' | null
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
    const tile = slot === null ? null : teleportTile(this.layout.rooms, slot, this.layout.walkable)
    this.at = tile ? { x: tile.x + 0.5, y: tile.y + 0.5 } : { ...ENTRANCE }
    this.path = []
    this.chasing = true
    this.syncPlayer()
    this.chase(true)
  }

  /** Per frame: held keys walk the Guild Master, otherwise a tapped path is followed. */
  override update(_time: number, delta: number): void {
    for (const view of this.members.values()) {
      const lift = view.bubble?.getData('lift')
      if (view.bubble && typeof lift === 'number') {
        view.bubble.setPosition(view.root.x, view.root.y - lift)
      }
    }
    if (!this.player) {
      return
    }
    const seconds = Math.min(delta, 100) / 1000
    const dir = direction(this.keys)
    if (dir.x !== 0 || dir.y !== 0) {
      this.path = []
      this.at = moveBy(
        this.at,
        dir.x * SPEED * seconds,
        dir.y * SPEED * seconds,
        this.layout.walkable
      )
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
      const route = findPath(this.layout.walkable, from, to)
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
    this.drawDynamic(state)
    this.drawMembers(state)
    this.drawApprentices(state)
    this.seeding = false
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
    const fitZoom = Math.min(this.scale.width / worldW, this.scale.height / worldH)
    this.zoomLevel = fitZoom >= 1 ? Math.floor(fitZoom) : fitZoom >= 0.5 ? 0.5 : 0.25
    if (keepFollow && this.chasing) {
      this.zoomLevel = Math.max(1, this.zoomLevel)
    }
    cam.setZoom(this.zoomLevel)
    this.centre()
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
        this.placeMember(
          member,
          member.status === 'working' ? work : seat,
          s,
          questBoardIn(this.layout, slot)
        )
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
        bubble: state.members[state.stewardId]?.bubble ?? null,
        claimSeq: null,
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
        const parent = owner ? this.members.get(owner.id)?.root : undefined
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

  private placeMember(
    member: SceneMember,
    tile: { x: number; y: number },
    s: number,
    board?: { x: number; y: number }
  ): void {
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
      view = {
        root,
        bubble: null,
        bubbleTimer: null,
        bubbleSeq: member.bubble?.seq ?? 0,
        claimSeq: member.claimSeq ?? 0,
        tx: x,
        ty: y,
        mode: null,
      }
      this.members.set(member.id, view)
      root.setPosition(x, y)
    } else {
      // A new claim walks the Member to their Hall's Quest Board first; reduced motion swaps.
      const claimed = member.claimSeq !== null && member.claimSeq > view.claimSeq
      view.claimSeq = member.claimSeq ?? 0
      if (view.tx !== x || view.ty !== y || claimed) {
        view.tx = x
        view.ty = y
        this.tweens.killTweensOf(view.root)
        if (this.options.reducedMotion || this.seeding) {
          view.root.setPosition(x, y)
        } else if (claimed && board) {
          const bx = board.x * s + s / 2
          const by = board.y * s + s / 2
          const root = view.root
          this.tweens.add({
            targets: root,
            x: bx,
            y: by,
            duration: WALK_MS,
            ease: 'Linear',
            onComplete: () =>
              this.tweens.add({ targets: root, x, y, duration: WALK_MS, ease: 'Linear' }),
          })
        } else {
          this.tweens.add({ targets: view.root, x, y, duration: 700, ease: 'Linear' })
        }
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
    const root = this.add.container(x, y - 16 - h / 2, [back, label]).setDepth(30)
    // The bubble rides above the sprite, so it stays with a Member who is walking to the board.
    root.setData('lift', 16 + h / 2)
    view.bubble = root
    view.bubbleTimer = this.time.delayedCall(BUBBLE_MS, () => {
      root.destroy()
      if (view.bubble === root) {
        view.bubble = null
      }
    })
  }
}
