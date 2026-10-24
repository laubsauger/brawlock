// Root-only temporary nginx route. Removes only this run's exact snippet.
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
module.exports = function route(configPath, action) {
  const { route } = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (!route || !['install', 'remove'].includes(action) || !/^\/etc\/nginx\/sites-available\/[a-z0-9.-]+$/.test(route.file)
    || !/^eu-\d+$/.test(route.run)) throw new Error('Invalid isolated Europe nginx route')
  const before = fs.readFileSync(route.file, 'utf8')
  let after
  if (action === 'install') {
    if (before.includes(`/_capacity/${route.run}/`)) throw new Error('Capacity route already installed')
    const marker = `    server_name ${route.hostname};\n`
    const index = before.indexOf(marker)
    if (index < 0) throw new Error('Expected Europe server block not found')
    after = before.slice(0, index + marker.length) + route.snippet + before.slice(index + marker.length)
  } else {
    if (!before.includes(route.snippet)) {
      if (before.includes(`/_capacity/${route.run}/`)) throw new Error('Capacity route changed; refusing to overwrite it')
      return
    }
    after = before.replace(route.snippet, '')
  }
  fs.writeFileSync(route.file, after)
  try { execFileSync('nginx', ['-t'], { stdio: 'pipe' }); execFileSync('systemctl', ['reload', 'nginx']) }
  catch (error) { fs.writeFileSync(route.file, before); throw error }
}
if (require.main === module) module.exports(process.argv[2], process.argv[3])
