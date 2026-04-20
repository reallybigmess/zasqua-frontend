## What is this?
Local modifications to zasqua-frontend.

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
