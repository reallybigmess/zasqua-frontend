## What is this?
Local modifications to zasqua-frontend. It generates a site specific to a project I did for my IST 660: Archival Representation course, but there's other stuff too.
#### Other stuff too
- Host the Zasqua site from a subdirectory by editing ‎`eleventy.config.js`. I have a much more manual pipeline plus GH pages as my host so this is what ended up working.
- English UI (strings are just translated in place for now)
- Style things, extra about page, etc.

## Getting Started
Prerequisites: Node.js 18+, npm, Tailwind binary

### Node.js Setup (with nvm):
- `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash`, close and reopen shell as prompted
- `nvm install 24 && nvm use 24`

### Tailwind:
`wget https://github.com/tailwindlabs/tailwindcss/releases/download/v4.2.2/tailwindcss-linux-x64 && mv tailwindcss-linux-x64 tailwindcss && chmod +x tailwindcss` (just downloading the binary CLI directly)
`sudo mv tailwindcss /usr/bin/` (alternatively, put the binary in your homedir and link it/install tailwind through npm/etc.)

### Frontend Setup:
- `git clone https://github.com/reallybigmess/zasqua-frontend.git && cd zasqua-frontend`
- `npm install`

`npm run css && npm run build`
`npm run dev` will open a dev server at localhost:8080
