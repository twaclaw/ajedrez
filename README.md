# Historical Chess Games

## Building

```
uv sync          # chess and pyyaml, per pyproject.toml
make             # the list of targets
make all         # the data and the rendered book, into _site
make preview     # the book, served, with live reload
make check       # every audit
make clean
```

## Adding a game

From scratch:

```
make new SLUG=1963-byrne-fischer    # writes games/1963-byrne-fischer.yml
$EDITOR games/1963-byrne-fischer.yml
make all
```

From a downloaded PGN:

```
# save the game as drafts/<game id>.pgn, then
make import                         # -> games/<year>-<white>-<black>.yml
make why                            # fills the why in, where Wikipedia has one
$EDITOR games/1862-steinitz-mongredien.yml
make all
```

The id is the number at the end of the game's URL, and the file name is how
the record learns which page to cite. Players, date, event, opening code,
result and moves are taken from the PGN; `title` must be manually edited.

`make why` reads Wikipedia's [list of chess
games](https://en.wikipedia.org/wiki/List_of_chess_games), finds the game by
the same id, and writes the sentence it gives as the record's `why`, together
with the two pages the sentence rests on: Wikipedia's own, and the one
Wikipedia cites for it. Both are marked `cited_by: why`, which is what puts
the reference after the sentence on the page. A why written for this book is
never written over, and `make why ARGS=--dry-run` says what would change
without changing it.

Several PGNs can be dropped in and imported at once, an existing record is
never overwritten, and every move is replayed on a board at import and again
at build, so a PGN that did not copy cleanly is refused rather than published.


## The board

A game page shows a read-only viewer. Three modes take it over and give it
back where they found it, each recolouring the board while it has it.

`Guess` asks for the move the game made next, and judges any other legal move
with Stockfish, then plays it and either reads on (`▸`) or asks the next one
(`▸?`).

`Explore` asks Stockfish what it would play here and lays the answer out as a
tree. Each of the four candidates is a card carrying the engine's ranking of
it, the move, what the position is worth after it, and a bar for the pawns it
gives up against the engine's own choice, with the replies the engine expects
beneath it. Hovering a move draws it on the board -- a reply draws the move it
answers too -- and clicking one plays it and asks the same question again, with
a breadcrumb back up the line. The move the game itself played is marked
wherever it turns up, and scored alongside the rest even when the engine would
not have proposed it, and once the reader has followed the game forward a card
offers the way back to it.

`vs Stockfish` hands the position over to play the rest of the game out against
the engine, which answers at the gentlest of three strengths until `vs` says
otherwise or turns it off, and takes back its reply along with your move.

Above the board, `Pieces` picks from eleven sets, each under a licence this book
can publish and each credited beside the picker. The choice follows the reader
through the book, and only the chosen set is ever fetched.

The viewer, the engine and the piece sets live in `book/assets` and are
committed.
`make vendor` refetches them, from the pins in `scripts/build/vendor.py`; the
build itself fetches nothing.

## Publishing

```
git add -A && git commit -m "..." && git push
make publish
```

## Sources

The selection started from Wikipedia's
[list of chess games](https://en.wikipedia.org/wiki/List_of_chess_games). The
moves come from the game's page at
[chessgames.com](https://www.chessgames.com/) and, where the game has an
article of its own, from Wikipedia, with the two compared. Every source is
listed in the chapter that uses it and collected in the book's
[Sources](book/sources.qmd) appendix.

The build fetches nothing. The game records were collected once, by hand, and
`games/` is the result; the build reads only what is already on disk, so
building the book does not go back to the sources it cites. The two commands
that do fetch, `make why` and `make vendor`, are run by hand and write what
they find into the repository, where it is committed and read from then on.
