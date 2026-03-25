#!/bin/bash
# CSS token verification for Phase 1.
# Checks that input.css defines all brand tokens and that compiled main.css
# contains no legacy colours.
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
