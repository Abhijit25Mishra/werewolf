# Werewolf

A Werewolf party game for friends sitting together: everyone plays on their own phone, and the server is the moderator. One player creates a room and shares a 4-letter code or QR code. Everyone joins and taps Ready, then the game deals secret roles and runs every night and day.

## Status

Planning is done; the code isn't written yet. [`PLAN.md`](PLAN.md) is the full game design and build spec: rules, 17 roles with balance values, UX, architecture, socket protocol, milestones, tests and deployment.

## Building it with Claude Code

Open Claude Code in this folder and ask:

> Read PLAN.md and build the game milestone by milestone (M0 to M6). Don't start a milestone until the previous one's acceptance checks pass. Commit after each milestone.

## Stack

Node.js 20+, Express, Socket.IO 4, and a plain HTML/CSS/JS client. It deploys as one Render web service, with a keep-alive so it never sleeps (see PLAN.md, Deployment).
