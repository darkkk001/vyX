#!/bin/sh
# Run once after cloning this repo. Git does not version-control or copy
# .git/hooks on clone, so the em/en-dash pre-commit guard
# (scripts/check-no-dashes.mjs) needs to be reinstalled here manually --
# no husky/dependency added just for one hook on a solo-dev project.
set -e
cd "$(dirname "$0")/.."
cat > .git/hooks/pre-commit << 'HOOK'
#!/bin/sh
node scripts/check-no-dashes.mjs
HOOK
chmod +x .git/hooks/pre-commit
echo "Installed .git/hooks/pre-commit (em-dash/en-dash guard)."
