const fs = require('node:fs')
fs.copyFileSync(require.resolve('bulma/css/bulma.min.css'), 'public/assets/styles/bulma.css')
