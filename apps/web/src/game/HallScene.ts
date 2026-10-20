import Phaser from 'phaser'
import { formatCents } from '../treasury'
import hallMap from './hall.tiled.json'
import { type HallLayout, hallLayout, seatsIn } from './layout'
import { lookFor } from './look'
import type { SceneMember, SceneState } from './scene'

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
}

interface MemberView {
  root: Phaser.GameObjects.Container
  bubble: Phaser.GameObjects.Container | null
  bubbleTimer: Phaser.Time.TimerEvent | null
  /** The last bubble seq drawn, so a bubble shows once. */
  bubbleSeq: number
  mode: 'idle' | 'working' | null
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
  private baselineSeq: number | null = null
  private gateSprites: Phaser.GameObjects.Image[] = []
  private zoomLevel = 1
  private followed: string | null = null

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
    this.scale.on('resize', () => this.fit())
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown) {
        const cam = this.cameras.main
        cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom
        cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom
      }
    })
    this.ready = true
    this.fit()
    if (this.pending) {
      this.render(this.pending)
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
    this.drawDynamic(state)
    this.drawMembers(state)
  }

  /** Zooms the camera by a step (clamped), keeping the hall centred. */
  zoomBy(step: number): void {
    this.zoomLevel = Math.min(4, Math.max(0.25, this.zoomLevel + step))
    this.cameras.main.setZoom(this.zoomLevel)
    this.centre()
  }

  /** Fits the whole hall in view: the largest whole zoom that fits, or a half step on a phone. */
  fit(): void {
    const cam = this.cameras.main
    cam.setSize(this.scale.width, this.scale.height)
    const worldW = px(this.layout.width, this.layout.tileSize)
    const worldH = px(this.layout.height, this.layout.tileSize)
    const fitZoom = Math.min(this.scale.width / worldW, this.scale.height / worldH)
    this.zoomLevel = fitZoom >= 1 ? Math.floor(fitZoom) : fitZoom >= 0.5 ? 0.5 : 0.25
    cam.setZoom(this.zoomLevel)
    this.centre()
  }

  /** Follows a Member's sprite with the camera (null returns to the fixed overview). */
  follow(memberId: string | null): void {
    this.followed = memberId
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
        (gate.y - 0.8) * s,
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
      const look = lookFor(member.id)
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
    const root = this.add.container(x, y - 26, [back, label]).setDepth(30)
    view.bubble = root
    view.bubbleTimer = this.time.delayedCall(BUBBLE_MS, () => {
      root.destroy()
      if (view.bubble === root) {
        view.bubble = null
      }
    })
  }
}
