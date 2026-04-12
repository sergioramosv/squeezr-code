#!/usr/bin/env node

import('../dist/index.js').catch((err) => {
  console.error('Failed to start squeezr-code:', err.message)
  console.error('Run "npm run build" first if you haven\'t compiled TypeScript.')
  process.exit(1)
})
