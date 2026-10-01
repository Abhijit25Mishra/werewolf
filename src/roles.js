'use strict';
// Role catalog, balance values and the auto deck builder (PLAN.md section 4).
// Values follow Ultimate Werewolf's scoring: village roles positive, wolf roles negative.

const ROLES = [
  {
    id: 'villager', name: 'Villager', team: 'village', value: 1, max: 30, killer: false, acts: 'No', icon: '🧑‍🌾',
    summary: 'No power. Find the wolves and vote them out.',
    rules: 'You have no special power. Listen, argue and vote the werewolves out.',
  },
  {
    id: 'seer', name: 'Seer', team: 'village', value: 7, max: 1, killer: false, acts: 'Every night', icon: '🔮',
    summary: 'Each night, learn whether one player is a werewolf.',
    rules: 'Each night, choose another living player and learn whether they are "a werewolf" or "not a werewolf". The Lycan reads as a werewolf; the Shadow Wolf, Minion and Sorceress read as not a werewolf.',
  },
  {
    id: 'apprentice', name: 'Apprentice Seer', team: 'village', value: 4, max: 1, killer: false, acts: 'Once the Seer is dead', icon: '📖',
    summary: "Takes over the Seer's power when the Seer dies.",
    rules: "Only dealt alongside a Seer. When the Seer dies you are told privately, and from the next night you check one player each night just like the Seer. Once you hold the power, the Sorceress's check counts you as the Seer.",
  },
  {
    id: 'doctor', name: 'Doctor', team: 'village', value: 3, max: 1, killer: false, acts: 'Every night', icon: '🩺',
    summary: 'Each night, protect one player from dying.',
    rules: "Each night, protect one living player from dying that night, to the werewolves or to poison. You may protect yourself, but never the same player two nights in a row. Protection doesn't stop heartbreak or the Hunter's shot.",
  },
  {
    id: 'witch', name: 'Witch', team: 'village', value: 4, max: 1, killer: false, acts: 'While a potion is left', icon: '🧪',
    summary: 'One healing potion and one poison, each used once.',
    rules: 'You have one healing potion and one poison, each usable once per game. While your heal is unused, you see who the werewolves attacked and may save one victim, yourself included. The poison kills any living player except you. You may use both in the same night.',
  },
  {
    id: 'hunter', name: 'Hunter', team: 'village', value: 3, max: 1, killer: false, acts: 'When they die', icon: '🏹',
    summary: 'When you die, you shoot one player.',
    rules: 'However you die, you immediately shoot one living player, who dies too. You have 30 seconds to aim.',
  },
  {
    id: 'cupid', name: 'Cupid', team: 'village', value: -3, max: 1, killer: false, acts: 'Night 1', icon: '💘',
    summary: 'On night 1, make two players fall in love.',
    rules: "On the first night, link two players, possibly yourself, as Lovers. When one Lover dies, the other dies of a broken heart. Lovers learn whether they share a team, can't vote for each other, and a wolf can't attack their own lover. Lovers from opposite teams (the solo Jester counts as one) win only as the last two alive. Cupid still wins with the village.",
  },
  {
    id: 'elder', name: 'Elder', team: 'village', value: 3, max: 1, killer: false, acts: 'No', icon: '👴',
    summary: 'Survives the first werewolf attack.',
    rules: 'The first time the werewolves attack you, you survive and are told so. A second attack, poison or the vote kills you.',
  },
  {
    id: 'prince', name: 'Prince', team: 'village', value: 3, max: 1, killer: false, acts: 'No', icon: '👑',
    summary: "The village can't vote you out the first time.",
    rules: 'The first time the village votes you out, your role is revealed and you survive. A second vote eliminates you.',
  },
  {
    id: 'mason', name: 'Mason', team: 'village', value: 2, max: 3, minIfAny: 2, killer: false, acts: 'No', icon: '🧱',
    summary: 'Masons know each other.',
    rules: 'You know who the other Masons are, and they know you. Masons come in twos or threes.',
  },
  {
    id: 'lycan', name: 'Lycan', team: 'village', value: -1, max: 1, killer: false, acts: 'No', icon: '🌕',
    summary: 'A villager the Seer sees as a werewolf.',
    rules: 'You are an ordinary villager, but the Seer sees you as a werewolf.',
  },
  {
    id: 'werewolf', name: 'Werewolf', team: 'wolves', value: -6, max: 6, killer: true, acts: 'Every night', icon: '🐺',
    summary: 'Each night, the pack picks a victim.',
    rules: 'You know the other killer wolves. Each night the pack agrees on a victim. The wolves win when they equal or outnumber everyone else.',
  },
  {
    id: 'shadowwolf', name: 'Shadow Wolf', team: 'wolves', value: -9, max: 1, killer: true, acts: 'Every night', icon: '🌑',
    summary: 'A werewolf the Seer sees as innocent.',
    rules: 'A werewolf in every way, except that the Seer sees you as not a werewolf.',
  },
  {
    id: 'wolfcub', name: 'Wolf Cub', team: 'wolves', value: -8, max: 1, killer: true, acts: 'Every night', icon: '🐾',
    summary: 'If you die, the pack kills two the next night.',
    rules: 'A werewolf. The night after you die, the pack takes two victims.',
  },
  {
    id: 'minion', name: 'Minion', team: 'wolves', value: -6, max: 1, killer: false, acts: 'No', icon: '🦹',
    summary: "Knows the wolves; they don't know you.",
    rules: "You know who the killer wolves are, but they don't know you. You never kill. The Seer sees you as not a werewolf. You win with the wolves and count on their side.",
  },
  {
    id: 'sorceress', name: 'Sorceress', team: 'wolves', value: -3, max: 1, killer: false, acts: 'Every night', icon: '🧙',
    summary: 'Each night, search for the Seer.',
    rules: "Each night, check one other player to learn whether they are the Seer. You don't know the wolves and they don't know you. The Seer sees you as not a werewolf. You win with the wolves.",
  },
  {
    id: 'jester', name: 'Jester', team: 'solo', value: 1, max: 1, killer: false, acts: 'No', icon: '🃏',
    summary: 'Wins alone if the village votes you out.',
    rules: 'You win alone, and the game ends at once, if the village votes you out. Dying at night is just a death.',
  },
];

const ROLE_IDS = ROLES.map((r) => r.id);
const ROLE_BY_ID = Object.fromEntries(ROLES.map((r) => [r.id, r]));
const ALWAYS_ALLOWED = ['werewolf', 'villager'];
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 20;

const isRole = (id) => Object.prototype.hasOwnProperty.call(ROLE_BY_ID, id);
const teamOf = (id) => ROLE_BY_ID[id].team;
const isKiller = (id) => ROLE_BY_ID[id].killer;
// What the Seer's check reports: the Lycan reads as a werewolf, the Shadow Wolf doesn't.
const seerSeesWolf = (id) => id === 'werewolf' || id === 'wolfcub' || id === 'lycan';

function countTotal(roles) {
  return Object.values(roles || {}).reduce((s, n) => s + n, 0);
}

function scoreDeck(roles) {
  return Object.entries(roles || {}).reduce((s, [id, n]) => s + (isRole(id) ? ROLE_BY_ID[id].value * n : 0), 0);
}

// Same scale for the manual meter and the auto target: -2 or below, -1..+3, +4 or above.
function bandOf(score) {
  if (score <= -2) return 'wolves';
  if (score >= 4) return 'village';
  return 'balanced';
}

const TILT_RANGES = { balanced: [-1, 3], village: [4, 7], wolves: [-5, -2] };
// Hidden roles help the wolves, so weaker reveals ask for a more village-friendly deck.
const REVEAL_SHIFT = { role: 0, day: 1, team: 1, wolf: 1, none: 2 };

function targetRange(tilt = 'balanced', reveal = 'role') {
  const [lo, hi] = TILT_RANGES[tilt] || TILT_RANGES.balanced;
  const shift = REVEAL_SHIFT[reveal] ?? 0;
  return [lo + shift, hi + shift];
}

function killerCount(playerCount) {
  if (playerCount <= 7) return 1;
  if (playerCount <= 11) return 2;
  if (playerCount <= 15) return 3;
  return 4;
}

// Hard rules only (count, per-role limits, killer wolf, Apprentice needs Seer, wolf team size).
// Player-count limits are the room's job; this checks the deck against a given count.
function validateDeck(roles, playerCount) {
  const errors = [];
  const counts = roles || {};
  for (const [id, n] of Object.entries(counts)) {
    if (!isRole(id)) { errors.push(`Unknown role: ${id}`); continue; }
    if (!Number.isInteger(n) || n < 0) { errors.push(`Bad count for ${ROLE_BY_ID[id].name}`); continue; }
    const info = ROLE_BY_ID[id];
    if (n > info.max) errors.push(`At most ${info.max} ${info.name}${info.max === 1 ? '' : 's'}`);
    if (info.minIfAny && n > 0 && n < info.minIfAny) errors.push(`${info.name}s come in twos or threes`);
  }
  const total = countTotal(counts);
  if (total < playerCount) errors.push(`Add ${playerCount - total} more role${playerCount - total === 1 ? '' : 's'}`);
  if (total > playerCount) errors.push(`Remove ${total - playerCount} role${total - playerCount === 1 ? '' : 's'}`);
  const killers = ROLE_IDS.filter(isKiller).reduce((s, id) => s + (counts[id] || 0), 0);
  if (killers < 1) errors.push('Add at least one werewolf');
  if ((counts.apprentice || 0) > 0 && (counts.seer || 0) < 1) errors.push('An Apprentice Seer needs a Seer');
  const wolfTeam = ROLE_IDS.filter((id) => teamOf(id) === 'wolves').reduce((s, id) => s + (counts[id] || 0), 0);
  if (total > 0 && wolfTeam * 2 >= total) errors.push('Too many wolves for this many players');
  return errors;
}

function shuffled(rng, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const SPECIALS = ['apprentice', 'doctor', 'witch', 'hunter', 'cupid', 'elder', 'prince', 'mason', 'lycan', 'minion', 'sorceress', 'jester'];

// One random legal-looking deck for this many players from the allowed roles.
function randomDeck(n, allowed, rng) {
  const roles = {};
  const add = (id, k = 1) => { roles[id] = (roles[id] || 0) + k; };
  let wolves = killerCount(n);
  if (allowed.has('wolfcub') && n >= 9 && rng() < 0.5) { add('wolfcub'); wolves--; }
  if (allowed.has('shadowwolf') && n >= 13 && wolves > 1 && rng() < 0.5) { add('shadowwolf'); wolves--; }
  add('werewolf', wolves);
  let free = n - killerCount(n);
  if (allowed.has('seer') && free > 0) { add('seer'); free--; }
  const pool = shuffled(rng, SPECIALS.filter((id) => allowed.has(id) && (id !== 'apprentice' || roles.seer)));
  // Small games get fewer specials; roughly a third to two thirds of the free seats.
  const want = Math.round(free * (0.3 + rng() * 0.4));
  let used = 0;
  for (const id of pool) {
    if (used >= want) break;
    const k = id === 'mason' ? (n >= 12 && rng() < 0.3 ? 3 : 2) : 1;
    if (used + k > free) continue;
    add(id, k);
    used += k;
  }
  if (free - used > 0) add('villager', free - used);
  for (const id of Object.keys(roles)) if (!roles[id]) delete roles[id];
  return roles;
}

function specialCount(roles) {
  return Object.entries(roles).reduce((s, [id, n]) => s + (id === 'villager' || id === 'werewolf' ? 0 : n), 0);
}

// Decks one swap away from `roles`: a Villager for an allowed special (two for a new Mason pair),
// a special back to Villagers, or a Werewolf for a Wolf Cub or Shadow Wolf and back.
function neighbourDecks(roles, n, allowed) {
  const out = [];
  const change = (fn) => {
    const r = { ...roles };
    fn(r);
    for (const id of Object.keys(r)) if (!r[id]) delete r[id];
    out.push(r);
  };
  const villagers = roles.villager || 0;
  for (const id of SPECIALS) {
    const k = id === 'mason' && !roles.mason ? 2 : 1;
    if (allowed.has(id) && villagers >= k) change((r) => { r.villager -= k; r[id] = (r[id] || 0) + k; });
  }
  for (const id of SPECIALS) {
    const k = id === 'mason' && roles.mason === 2 ? 2 : 1;
    if (roles[id]) change((r) => { r[id] -= k; r.villager = (r.villager || 0) + k; });
  }
  for (const [id, min] of [['wolfcub', 9], ['shadowwolf', 13]]) {
    if (roles[id]) change((r) => { r[id] -= 1; r.werewolf = (r.werewolf || 0) + 1; });
    else if (allowed.has(id) && n >= min && roles.werewolf) change((r) => { r.werewolf -= 1; r[id] = 1; });
  }
  return out;
}

// The random search can miss a narrow target in big games (e.g. 16 players, Village-friendly,
// no reveal). Walk from the closest deck, one legal swap at a time, while it gets closer.
function repairDeck(best, n, allowed, distance) {
  let cur = best;
  for (let step = 0; step < 30 && cur.d > 0; step++) {
    let next = null;
    for (const roles of neighbourDecks(cur.roles, n, allowed)) {
      if (validateDeck(roles, n).length) continue;
      const score = scoreDeck(roles);
      const d = distance(score);
      const specials = specialCount(roles);
      const bar = next || cur;
      if (d < bar.d || (next && d === bar.d && specials < bar.specials)) next = { roles, score, d, specials };
    }
    if (!next) break;
    cur = next;
  }
  return cur;
}

// Auto mode: 500 seeded random legal decks, keep the one closest to the target range.
function buildAutoDeck({ playerCount, allowedRoles = ROLE_IDS, tilt = 'balanced', reveal = 'role', rng = Math.random, tries = 500 }) {
  const target = targetRange(tilt, reveal);
  const n = Math.max(0, Math.min(MAX_PLAYERS, playerCount | 0));
  if (n < 3) {
    // Too few players for a real deck; show something sensible in the lobby.
    const roles = n ? { werewolf: 1, ...(n > 1 ? { villager: n - 1 } : {}) } : {};
    const score = scoreDeck(roles);
    return { roles, score, band: bandOf(score), target, inRange: false, suggestions: [] };
  }
  const allowed = new Set([...(allowedRoles || []).filter(isRole), ...ALWAYS_ALLOWED]);
  const distance = (s) => (s < target[0] ? target[0] - s : s > target[1] ? s - target[1] : 0);
  let best = null;
  for (let i = 0; i < tries; i++) {
    const roles = randomDeck(n, allowed, rng);
    if (validateDeck(roles, n).length) continue;
    const score = scoreDeck(roles);
    const d = distance(score);
    const specials = specialCount(roles);
    if (!best || d < best.d || (d === best.d && n <= 8 && specials < best.specials)) best = { roles, score, d, specials };
    if (d === 0 && n > 8 && i > 50) break; // a fitting deck is enough for bigger games
  }
  if (!best) {
    const roles = { werewolf: killerCount(n), villager: n - killerCount(n) };
    best = { roles, score: scoreDeck(roles), d: distance(scoreDeck(roles)), specials: 0 };
  }
  if (best.d > 0) best = repairDeck(best, n, allowed, distance);
  const inRange = best.d === 0;
  let suggestions = [];
  if (!inRange) {
    const tooHigh = best.score > target[1];
    suggestions = ROLE_IDS
      .filter((id) => !allowed.has(id) && (tooHigh ? ROLE_BY_ID[id].value < 0 : ROLE_BY_ID[id].value > 1))
      .filter((id) => id !== 'apprentice' || allowed.has('seer'))
      .slice(0, 3);
  }
  return { roles: best.roles, score: best.score, band: bandOf(best.score), target, inRange, suggestions };
}

// What GET /api/roles serves.
function roleInfoList() {
  return ROLES.map(({ id, name, team, value, max, minIfAny, killer, acts, summary, rules, icon }) => (
    { id, name, team, value, max, ...(minIfAny ? { minIfAny } : {}), killer, acts, summary, rules, icon }
  ));
}

module.exports = {
  ROLES, ROLE_IDS, ROLE_BY_ID, ALWAYS_ALLOWED, MIN_PLAYERS, MAX_PLAYERS,
  isRole, teamOf, isKiller, seerSeesWolf,
  countTotal, scoreDeck, bandOf, targetRange, killerCount, validateDeck, buildAutoDeck, roleInfoList, shuffled,
};
