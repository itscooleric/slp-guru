# slp-guru

```text

  ███████╗██╗     ██████╗      ██████╗ ██╗   ██╗██████╗ ██╗   ██╗
  ██╔════╝██║     ██╔══██╗    ██╔════╝ ██║   ██║██╔══██╗██║   ██║
  ███████╗██║     ██████╔╝    ██║  ███╗██║   ██║██████╔╝██║   ██║
  ╚════██║██║     ██╔═══╝     ██║   ██║██║   ██║██╔══██╗██║   ██║
  ███████║███████╗██║         ╚██████╔╝╚██████╔╝██║  ██║╚██████╔╝
  ╚══════╝╚══════╝╚═╝          ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝

  deep analysis of Slippi replay files for SSBM
  ────────────────────────────────────────────────

  .slp replay ──parse──► event stream ──► stats + insights

```

Node.js tool for deep analysis of [Slippi](https://slippi.gg) `.slp` replay files from Super Smash Bros. Melee. Streams replay data through an analysis pipeline to surface skill metrics and match patterns beyond what Slippi's built-in stats show.

## Usage

```bash
npm install
node index_stream.js path/to/replay.slp
```

## Analysis

- Per-frame action state breakdown
- Input frequency and timing
- Kill move distribution
- Stock differential tracking

## Requirements

Node.js 14+. Uses [slippi-js](https://github.com/project-slippi/slippi-js) for `.slp` parsing.

## Related

- [slippi-js](https://github.com/project-slippi/slippi-js) — official Slippi replay parser
- [Slippi](https://slippi.gg) — rollback netplay for Melee
