'use strict';
// Checks one snapshot against the true game state and returns a list of problems.
// Only rules that can't be skewed by the snapshot being a few ms old are checked.
const R = require('../../src/roles');

const TASK_OWNER = {
  wolf: (role) => R.isKiller(role),
  meet: (role) => R.isKiller(role),
  witch: (role) => role === 'witch',
  seer: (role) => role === 'seer' || role === 'apprentice',
  sorceress: (role) => role === 'sorceress',
  doctor: (role) => role === 'doctor',
  cupid: (role) => role === 'cupid',
};

function checkSnapshot(snap, truthFor) {
  const problems = [];
  const g = snap && snap.game;
  if (!g) return problems;
  const room = snap.room;
  const truth = truthFor(room.code);
  if (!truth) return problems;
  const me = room.you;
  const myRole = truth.roles[me];
  const dead = myRole !== undefined && !truth.alive.has(me);

  if (!room.isHost && room.reclaims && room.reclaims.length) problems.push('reclaim requests sent to a non-host');
  if (g.history && g.phase !== 'over') problems.push('history sent before game over');
  if (g.me && myRole && g.me.role !== myRole) problems.push(`me.role ${g.me.role} but true role is ${myRole}`);

  for (const p of g.players || []) {
    if (p.role == null) continue;
    const real = truth.roles[p.id];
    if (p.role !== real) { problems.push(`${p.name} shown as ${p.role}, really ${real}`); continue; }
    if (g.phase === 'over' || p.id === me || !myRole) continue;
    const allowed =
      (R.isKiller(myRole) && R.isKiller(real)) ||
      (myRole === 'minion' && R.isKiller(real)) ||
      (myRole === 'mason' && real === 'mason') ||
      (p.revealed && p.revealed.kind === 'role') ||
      real === 'prince' || real === 'hunter' ||   // revealed by their own public actions
      (dead && room.settings.deadSeeRoles && !room.isHost);
    if (!allowed) problems.push(`${p.name}'s role (${real}) leaked to a ${myRole}`);
  }

  const task = g.night && g.night.task;
  if (task && myRole) {
    const owner = TASK_OWNER[task.kind];
    if (owner && !owner(myRole)) problems.push(`${myRole} got a ${task.kind} task`);
    if (task.kind === 'ghost' && !dead) problems.push('living player got a ghost task');
    if (task.wolf && !R.isKiller(myRole)) problems.push('pack picks sent to a non-wolf');
    if (task.witch && myRole !== 'witch') problems.push('witch data sent to a non-witch');
  }
  if (g.night) {
    for (const [k, v] of Object.entries(g.night)) if (typeof v === 'number') problems.push(`numeric night field ${k} could leak progress`);
  }

  if (g.me && myRole) {
    const k = g.me.knows || {};
    for (const id of k.pack || []) if (!R.isKiller(truth.roles[id])) problems.push('pack lists a non-killer');
    for (const id of k.wolves || []) if (!R.isKiller(truth.roles[id])) problems.push('minion sees a non-killer');
    for (const id of k.masons || []) if (truth.roles[id] !== 'mason') problems.push('masons list a non-mason');
    if ((k.pack || []).length && !R.isKiller(myRole)) problems.push('non-wolf told about the pack');
    if ((k.wolves || []).length && myRole !== 'minion') problems.push('non-minion told who the wolves are');
  }

  const d = g.day;
  if (d) {
    if (d.shot && d.shooter !== me) problems.push('shot targets sent to someone other than the Hunter');
    if (d.vote && d.vote.live && room.settings.voteStyle !== 'live') problems.push('live votes sent in a secret vote');
  }
  return problems;
}

module.exports = { checkSnapshot };
