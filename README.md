## What is this?
A fork of the [Zasqua](https://github.com/neogranadina/zasqua) frontend. It generates a site specific to a project I did for my IST 660: Archival Representation course, but there's other stuff too.

All modifications are done organically by me and I'm not associated with the main Zasqua project, AMPL, etc.

#### Other stuff too
- Builds local by default
- ~Host the Zasqua site from a subdirectory by editing ‎`eleventy.config.js`. I have a much more manual pipeline plus GH pages as my host so this is what ended up working.~ Does not work since they moved to Hugo.
- English UI stapled on. Some added variables data/ui.yaml for Hugo templates. (Vars in Javascript are string changes)
- Style things, extra about page, etc.

## Getting Started
Prerequisites: Node.js 22+, npm

### Node.js Setup (with nvm):
- `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash`, close and reopen shell as prompted
- `nvm install 24 && nvm use 24`

### Frontend Setup:
- `git clone https://github.com/reallybigmess/zasqua-frontend.git && cd zasqua-frontend`
- `npm install`

`npm run build && npm run dev` will open a dev server at localhost:1313

## To-Do:
- In entity explorer, centered fam/corp should be blue not red
- Entity explorer, show document labels?
- Repo note (description) doesn't show