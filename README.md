# Departure Board

![Departure Board demo](media/demo.gif)

*Claude makes a 4-step task list and the split-flap band cascades each row from BOARDING to DEPARTED.* [Watch the MP4](https://github.com/ccdwyer/claude-mods/raw/main/media/departure-board.mp4)

A Solari split-flap departure board for what Claude is actually doing. Every character is a flap that falls through the drum, letter by letter in amber on black, at about 30 fps, with a left-to-right cascade.

- **Rows are real work items.** Claude's task list is used while it has items still to go (TodoWrite, or TaskCreate and TaskUpdate; a TaskList snapshot drops tasks deleted elsewhere). Without one, or once it's all done, each prompt you send is a departure, opened when the turn that carries it starts, so a prompt typed mid-turn waits its turn. Two todos with identical text are told apart by position, since TodoWrite has no ids.
- **Columns:** `TIME · DESTINATION · PLATFORM · STATUS`. The platform is the file or tool Claude is on right now.
- **Status:** `ON TIME` (pending) → `BOARDING` (in progress) → `DEPARTED` (done). An error while boarding turns it `DELAYED`, and an interrupted or deleted item is `CANCELLED`.
- **Mini board** above the prompt (up to 3 rows) shares the band with other mods.
- **`/board`** opens the full board in a pane.
- **`/board band off`** hides the mini board, and `/board band on` brings it back.
- **Optional flap sound:** set `clack` in the plugin settings. It's off by default, plays on macOS only, and the sound is self-made.

The clock only runs while flaps are falling, so an idle board costs nothing. On surfaces without cell graphics (desktop) the board is drawn as text.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install departure-board@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```

## What it hooks

- `session.start`: registers `/board`.
- `command.run` (`/board`): opens the pane or toggles the mini board.
- `prompt.submit` and `turn.start`: a prompt you type becomes a departure when its turn starts (when there's no live task list).
- `tool.call`: watches TodoWrite, TaskCreate and TaskUpdate for the rows, and every other call for the platform column and errors. It never changes, refuses or annotates a call.
- `turn.complete`: a turn's departure becomes DEPARTED, CANCELLED or stays DELAYED.
- `ui.render` (`AbovePrompt`, `Pane`): draws the board. The band is drawn above whatever other mods draw there.
- `ui.close`: forgets the pane's animation state.

## Privacy

It runs entirely on your machine. It sends nothing over the network. It reads Claude's task list and tool calls in this session only.

Full policy: [PRIVACY.md](PRIVACY.md).

## License

MIT
