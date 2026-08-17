import { FACTIONS, Faction, PLAYABLE_FACTIONS } from '../data/factions';

/**
 * Выбор судьбы: за кого играть.
 *
 * Имя злодея игрок придумывает сам — в техзадании оно так и осталось
 * непридуманным, так что пусть придумывает тот, кто им будет.
 */
export interface StartChoice {
  faction: Faction;
  name: string;
}

const FLAVOUR: Record<Faction, { start: string; goal: string }> = {
  [Faction.Elves]: {
    start: 'Начало: опушка родного леса',
    goal: 'Бить из засад, грабить обозы императора, не пускать чужих в чащу.',
  },
  [Faction.Palace]: {
    start: 'Начало: казармы у дворца',
    goal: 'Слушаться командира, водить корованы, держать дворец.',
  },
  [Faction.Villain]: {
    start: 'Начало: старый форт в горах',
    goal: 'Никому не подчиняться. Собрать банду и взять дворец.',
  },
  [Faction.Neutral]: { start: '', goal: '' },
};

export class StartMenu {
  private readonly root: HTMLDivElement;
  private readonly nameField: HTMLInputElement;
  private readonly nameRow: HTMLDivElement;
  private selected: Faction = Faction.Elves;
  private resolve?: (choice: StartChoice) => void;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.id = 'start-menu';
    this.root.innerHTML = TEMPLATE;
    parent.appendChild(this.root);

    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    const cards = this.root.querySelector('#start-cards') as HTMLDivElement;
    this.nameField = this.root.querySelector('#start-name') as HTMLInputElement;
    this.nameRow = this.root.querySelector('#start-name-row') as HTMLDivElement;

    for (const faction of PLAYABLE_FACTIONS) {
      cards.appendChild(this.createCard(faction));
    }

    (this.root.querySelector('#start-go') as HTMLButtonElement).addEventListener('click', () => this.confirm());
    this.nameField.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.confirm();
      event.stopPropagation();
    });

    this.select(Faction.Elves);
    this.root.style.display = 'none';
  }

  private createCard(faction: Faction): HTMLElement {
    const info = FACTIONS[faction];
    const card = document.createElement('button');
    card.className = 'start-card';
    card.dataset.faction = faction;
    card.innerHTML = `
      <span class="start-swatch" style="background:#${info.color.toString(16).padStart(6, '0')};
        border-color:#${info.accent.toString(16).padStart(6, '0')}"></span>
      <span class="start-card-name">${info.name}</span>
      <span class="start-card-text">${info.description}</span>
      <span class="start-card-goal">${FLAVOUR[faction].goal}</span>
      <span class="start-card-start">${FLAVOUR[faction].start}</span>
    `;
    card.addEventListener('click', () => this.select(faction));
    return card;
  }

  private select(faction: Faction): void {
    this.selected = faction;
    for (const card of this.root.querySelectorAll<HTMLElement>('.start-card')) {
      card.classList.toggle('start-selected', card.dataset.faction === faction);
    }

    // Имя спрашиваем только у злодея: у эльфа и стражника оно и так есть.
    const isVillain = faction === Faction.Villain;
    this.nameRow.style.visibility = isVillain ? 'visible' : 'hidden';
    if (isVillain && !this.nameField.value) this.nameField.value = '';
  }

  private confirm(): void {
    const typed = this.nameField.value.trim();
    const name =
      this.selected === Faction.Villain
        ? typed || 'Безымянный'
        : this.selected === Faction.Elves
          ? 'лесной эльф'
          : 'стражник дворца';

    this.root.style.display = 'none';
    this.resolve?.({ faction: this.selected, name });
    this.resolve = undefined;
  }

  /** Показать меню и дождаться выбора. */
  choose(): Promise<StartChoice> {
    this.root.style.display = 'flex';
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  dispose(): void {
    this.root.remove();
  }
}

const TEMPLATE = `
  <div id="start-window">
    <h1>Грабим Корованы 2</h1>
    <p id="start-lead">Выберите, за кого играть. Мир один и тот же — меняется только ваша сторона в нём.</p>
    <div id="start-cards"></div>
    <div id="start-name-row">
      <label for="start-name">Имя злодея</label>
      <input id="start-name" maxlength="24" placeholder="Безымянный" autocomplete="off" />
    </div>
    <button id="start-go">Начать</button>
  </div>
`;

const STYLES = `
  #start-menu {
    position: fixed; inset: 0; z-index: 40; display: none; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at 50% 35%, rgba(24,34,24,0.94), rgba(5,8,6,0.98));
    font: 14px/1.6 "Trebuchet MS", system-ui, sans-serif; color: #e4dcc6;
  }
  #start-window {
    width: min(940px, 94vw); display: flex; flex-direction: column; align-items: center; gap: 16px;
    padding: 26px; text-align: center;
  }
  #start-window h1 {
    margin: 0; font-size: clamp(26px, 5vw, 46px); letter-spacing: 0.05em; color: #d9b45a;
    text-shadow: 0 4px 26px rgba(0,0,0,0.8);
  }
  #start-lead { margin: 0; opacity: 0.7; max-width: 620px; }
  #start-cards { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; width: 100%; }
  .start-card {
    flex: 1 1 260px; max-width: 300px; display: flex; flex-direction: column; gap: 7px; text-align: left;
    padding: 16px; border-radius: 8px; cursor: pointer; color: inherit; font: inherit;
    background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.12);
    transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
  }
  .start-card:hover { background: rgba(255,255,255,0.08); transform: translateY(-2px); }
  .start-selected { border-color: rgba(217,180,90,0.85); background: rgba(217,180,90,0.12); }
  .start-swatch { width: 100%; height: 5px; border-radius: 3px; border-bottom: 2px solid; }
  .start-card-name { font-size: 18px; color: #e8e2d0; }
  .start-card-text { font-size: 13px; opacity: 0.72; }
  .start-card-goal { font-size: 13px; color: #b6c98f; }
  .start-card-start { font-size: 12px; opacity: 0.45; margin-top: auto; }
  #start-name-row { display: flex; align-items: center; gap: 10px; visibility: hidden; }
  #start-name-row label { font-size: 13px; opacity: 0.7; }
  #start-name {
    font: inherit; color: #e8e2d0; background: rgba(0,0,0,0.4); padding: 7px 11px; border-radius: 5px;
    border: 1px solid rgba(217,180,90,0.4); min-width: 220px;
  }
  #start-go {
    font: 16px/1 "Trebuchet MS", system-ui, sans-serif; color: #1a1a12; cursor: pointer;
    background: #d9b45a; border: none; padding: 12px 34px; border-radius: 5px; letter-spacing: 0.05em;
  }
  #start-go:hover { background: #e8c877; }
`;
