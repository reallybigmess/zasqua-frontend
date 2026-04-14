#!/bin/bash
# CSS Token Verification
#
# This script guards the visual consistency of the site by checking that
# the hand-written CSS source (`src/css/input.css`) declares every brand
# colour token that the design system relies on, and that the compiled
# output (`src/css/main.css`) does not still contain any of the older
# accent colours that the redesign retired.
#
# It runs two groups of checks:
#
#   1. Every named brand token — burgundy and its shades, pale rose,
#      ochre, sage, periwinkle, and the base background — must appear
#      somewhere in `input.css`. These are the colour variables exposed
#      to Tailwind through the `@theme` block so they can be used as
#      utility classes across templates.
#   2. The compiled stylesheet must contain zero instances of the legacy
#      blue accents (the old RGB triple and the two discarded hex codes)
#      and none of the retired orange hover colours.
#
# Run it after editing colour tokens or before merging any change that
# touches the stylesheet. It exits 0 when every check passes and 1 when
# anything is missing or left behind, so it slots naturally into a
# pre-commit hook or CI step.
#
# Version: v0.4.0

set -e

INPUT="src/css/input.css"
CSS="src/css/main.css"
ERRORS=0

echo "=== CSS Token Verification ==="

# COL-01: Brand tokens defined in input.css @theme block
for token in color-burgundy color-burgundy-deep color-burgundy-light color-burgundy-dark \
             color-pale-rose color-ochre color-sage color-periwinkle color-bg; do
  if grep -q "$token" "$INPUT"; then
    echo "PASS: $token defined in input.css"
  else
    echo "FAIL: $token NOT defined in input.css"
    ERRORS=$((ERRORS + 1))
  fi
done

# COL-03: No blue accent colours in compiled output
BLUE_COUNT=$(grep -c "41,98,255\|2c3e50\|003660" "$CSS" || true)
if [ "$BLUE_COUNT" -eq 0 ]; then
  echo "PASS: No blue accent colours"
else
  echo "FAIL: $BLUE_COUNT blue accent colour(s) remain"
  ERRORS=$((ERRORS + 1))
fi

# COL-04: No orange hover colours in compiled output
ORANGE_COUNT=$(grep -ci "f18e00\|F2784B" "$CSS" || true)
if [ "$ORANGE_COUNT" -eq 0 ]; then
  echo "PASS: No orange hover colours"
else
  echo "FAIL: $ORANGE_COUNT orange hover colour(s) remain"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "All checks passed."
  exit 0
else
  echo "$ERRORS check(s) failed."
  exit 1
fi
