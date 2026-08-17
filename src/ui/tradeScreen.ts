import { Inventory, tryItem, type ItemDef } from '../data/items';
import { ALL_BODY_PARTS, PART_NAMES, type Body } from '../entities/body';
import type { Economy, Market } from '../systems/economy';
import type { Reputation } from '../systems/reputation';

/**
 * Мешок и торговля — как в Daggerfall: список слева, прилавок справа, цены
 * зависят от города и от того, как к вам тут относятся.
 *
 * Протез покупается и ставится сразу: отдал золото — снова на ногах.
 */
export interface TradeActions {
  buy(def: ItemDef): void;
  sell(def: ItemDef): void;
  use(def: ItemDef): void;
  equip(def: ItemDef): void;
  heal(): void;
  close(): void;
}

export interface TradeContext {
  inventory: Inventory;
  wounds: Body;
  economy: Economy;
  reputation: Reputation;
  /** Прилавок; без него открыт просто мешок. */
  market?: Market;
  /** Сколько стоит полное лечение у этого лекаря. */
  healCost: number;
  actions: TradeActions;
}

export class TradeScreen {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly bagList: HTMLElement;
  private readonly stockPanel: HTMLElement;
  private readonly stockList: HTMLElement;
  private readonly footer: HTMLElement;

  private context: TradeContext | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'trade-screen';
    this.root.innerHTML = TEMPLATE;
    parent.appendChild(this.root);

    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    this.title = this.require('#trade-title');
    this.subtitle = this.require('#trade-subtitle');
    this.bagList = this.require('#trade-bag');
    this.stockPanel = this.require('#trade-stock-panel');
    this.stockList = this.require('#trade-stock');
    this.footer = this.require('#trade-footer');

    this.require('#trade-close').addEventListener('click', () => this.context?.actions.close());
    this.root.style.display = 'none';
  }

  private require(selector: string): HTMLElement {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`В экране торговли нет элемента ${selector}`);
    return element;
  }

  get isOpen(): boolean {
    return this.context !== null;
  }

  open(context: TradeContext): void {
    this.context = context;
    this.root.style.display = 'flex';
    this.refresh();
  }

  close(): void {
    this.context = null;
    this.root.style.display = 'none';
  }

  /** Перерисовать содержимое. Строк десятки, поэтому просто пересобираем. */
  refresh(): void {
    const context = this.context;
    if (!context) return;

    const { market, economy, reputation, inventory } = context;

    this.title.textContent = market ? market.name : 'Мешок';
    this.subtitle.textContent = market
      ? `отношение: ${reputation.describe(market.owner)} · золота ${inventory.gold} · вес ${inventory.totalWeight.toFixed(1)} кг`
      : `золота ${inventory.gold} · вес ${inventory.totalWeight.toFixed(1)} кг`;

    this.renderBag(context);
    this.stockPanel.style.display = market ? 'flex' : 'none';
    if (market) this.renderStock(context, market, economy);
    this.renderFooter(context);
  }

  private renderBag(context: TradeContext): void {
    const { inventory, market, economy, reputation } = context;
    this.bagList.innerHTML = '';

    if (inventory.stacks.length === 0) {
      this.bagList.innerHTML = '<div class="trade-empty">Пусто</div>';
      return;
    }

    for (const stack of inventory.stacks) {
      const def = tryItem(stack.id);
      if (!def) continue;

      const row = document.createElement('div');
      row.className = 'trade-row';

      const name = document.createElement('div');
      name.className = 'trade-name';
      const equipped =
        inventory.equippedWeapon === def.id || inventory.equippedArmor === def.id ? ' <b>(надето)</b>' : '';
      name.innerHTML = `${def.name}${stack.count > 1 ? ` ×${stack.count}` : ''}${equipped}`;
      name.title = def.description;

      const buttons = document.createElement('div');
      buttons.className = 'trade-buttons';

      if (def.kind === 'weapon') {
        buttons.appendChild(this.button('в руки', () => context.actions.equip(def)));
      } else if (def.kind === 'armor') {
        buttons.appendChild(this.button('надеть', () => context.actions.equip(def)));
      } else if (def.bandage || def.heal) {
        buttons.appendChild(this.button('применить', () => context.actions.use(def)));
      } else if (def.prostheticFor || def.wheelchair) {
        buttons.appendChild(this.button('поставить', () => context.actions.use(def)));
      }

      if (market) {
        const price = economy.sellPrice(def.id, market.siteId, reputation);
        buttons.appendChild(this.button(`продать ${price}`, () => context.actions.sell(def)));
      }

      row.append(name, buttons);
      this.bagList.appendChild(row);
    }
  }

  private renderStock(context: TradeContext, market: Market, economy: Economy): void {
    this.stockList.innerHTML = '';

    for (const entry of economy.stockOf(market.siteId, context.reputation)) {
      const row = document.createElement('div');
      row.className = 'trade-row';

      const name = document.createElement('div');
      name.className = 'trade-name';
      const shortage = economy.shortageOf(market.siteId, entry.def.id);
      name.innerHTML = entry.def.name + (shortage > 0.05 ? ' <i class="trade-short">дефицит</i>' : '');
      name.title = entry.def.description;

      const buttons = document.createElement('div');
      buttons.className = 'trade-buttons';
      const affordable = context.inventory.gold >= entry.price;
      const buy = this.button(`купить ${entry.price}`, () => context.actions.buy(entry.def));
      if (!affordable) buy.classList.add('trade-disabled');
      buttons.appendChild(buy);

      row.append(name, buttons);
      this.stockList.appendChild(row);
    }
  }

  private renderFooter(context: TradeContext): void {
    this.footer.innerHTML = '';

    const injuries: string[] = [];
    for (const part of ALL_BODY_PARTS) {
      const status = context.wounds.get(part);
      if (status.severed && !status.prosthetic) injuries.push(PART_NAMES[part]);
    }

    if (injuries.length > 0) {
      const note = document.createElement('div');
      note.className = 'trade-note';
      note.textContent = `Не хватает: ${injuries.join(', ')}. Протез вернёт вас в строй.`;
      this.footer.appendChild(note);
    }

    if (context.market?.healer) {
      const needsHelp = context.wounds.vitality < 0.999 || context.wounds.isBleeding;
      const heal = this.button(
        needsHelp ? `лечение — ${context.healCost} зол.` : 'вы здоровы',
        () => context.actions.heal(),
      );
      if (!needsHelp || context.inventory.gold < context.healCost) heal.classList.add('trade-disabled');
      this.footer.appendChild(heal);
    }

    const hint = document.createElement('div');
    hint.className = 'trade-hint';
    hint.textContent = 'Esc — закрыть';
    this.footer.appendChild(hint);
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'trade-btn';
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
      this.refresh();
    });
    return button;
  }

  dispose(): void {
    this.root.remove();
  }
}

const TEMPLATE = `
  <div id="trade-window">
    <header>
      <div>
        <div id="trade-title"></div>
        <div id="trade-subtitle"></div>
      </div>
      <button id="trade-close" class="trade-btn">закрыть</button>
    </header>
    <div id="trade-columns">
      <section class="trade-panel">
        <h3>В мешке</h3>
        <div id="trade-bag" class="trade-list"></div>
      </section>
      <section class="trade-panel" id="trade-stock-panel">
        <h3>На прилавке</h3>
        <div id="trade-stock" class="trade-list"></div>
      </section>
    </div>
    <footer id="trade-footer"></footer>
  </div>
`;

const STYLES = `
  #trade-screen {
    position: fixed; inset: 0; z-index: 25; display: none; align-items: center; justify-content: center;
    background: rgba(4,7,5,0.72); backdrop-filter: blur(3px);
    font: 14px/1.5 "Trebuchet MS", system-ui, sans-serif; color: #e4dcc6;
  }
  #trade-window {
    width: min(880px, 92vw); max-height: 86vh; display: flex; flex-direction: column; gap: 12px;
    padding: 18px 20px; border-radius: 8px;
    background: linear-gradient(180deg, rgba(26,32,26,0.97), rgba(14,18,14,0.98));
    border: 1px solid rgba(217,180,90,0.35); box-shadow: 0 24px 70px rgba(0,0,0,0.65);
  }
  #trade-window header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  #trade-title { font-size: 22px; color: #d9b45a; letter-spacing: 0.03em; }
  #trade-subtitle { font-size: 13px; opacity: 0.7; margin-top: 2px; }
  #trade-columns { display: flex; gap: 16px; min-height: 0; flex: 1; }
  .trade-panel {
    flex: 1; display: flex; flex-direction: column; min-height: 0;
    border: 1px solid rgba(255,255,255,0.09); border-radius: 6px; background: rgba(0,0,0,0.25);
  }
  .trade-panel h3 {
    margin: 0; padding: 8px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em;
    color: rgba(232,226,208,0.55); border-bottom: 1px solid rgba(255,255,255,0.08); font-weight: normal;
  }
  .trade-list { overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 3px; }
  .trade-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 5px 8px; border-radius: 4px;
  }
  .trade-row:nth-child(odd) { background: rgba(255,255,255,0.035); }
  .trade-name { flex: 1; }
  .trade-name b { color: #a8cc7e; font-weight: normal; }
  .trade-short { color: #e2a06b; font-style: normal; font-size: 11px; margin-left: 6px; }
  .trade-buttons { display: flex; gap: 6px; }
  .trade-btn {
    font: 12px/1 "Trebuchet MS", system-ui, sans-serif; color: #e8e2d0; cursor: pointer;
    background: rgba(217,180,90,0.14); border: 1px solid rgba(217,180,90,0.4);
    padding: 6px 10px; border-radius: 4px; white-space: nowrap;
  }
  .trade-btn:hover { background: rgba(217,180,90,0.28); }
  .trade-disabled { opacity: 0.35; pointer-events: none; }
  .trade-empty { padding: 14px; opacity: 0.45; text-align: center; }
  #trade-footer { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .trade-note { flex: 1; font-size: 13px; color: #d8956a; }
  .trade-hint { margin-left: auto; font-size: 12px; opacity: 0.45; }
`;
