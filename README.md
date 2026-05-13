## What is this?
A fork of the [Zasqua](https://github.com/neogranadina/zasqua) frontend. It generates a site specific to a project I did for my IST 660: Archival Representation course, but there's other stuff too.

All modifications are done organically by me and I'm not associated with the main Zasqua project, AMPL, etc.

#### Other stuff too
- Builds local by default
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

## To-Do/Fix:
- Index description notes so that they're searchable
- Show document labels of individual items in entity explorer?
- Repo note (description) doesn't show in /description 
- Passthru formatting (or at least line breaks etc) in Django fields?
- Search.js - adding "no" to a search doesn't seem to work (i.e. searching for "Kutt" and No:"president" or "Correspondence" and No:"Intel")
- Integrating entities/places into search?