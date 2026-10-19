import { releaseMetadata } from '../scripts/release-version.mjs'

// Remote immutable tags identify the source that actually passed fleet proof.
// API/network failures propagate; they must never be interpreted as a missing tag.
export async function releaseTag({ repository, tag, revision, publish = false }, run) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^v[0-9A-Za-z.+-]+$/.test(tag) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid release tag identity')
  const base = `repos/${repository}`
  const refs = JSON.parse(await run('gh', ['api', `${base}/git/matching-refs/tags/${encodeURIComponent(tag)}`]))
  if (!Array.isArray(refs)) throw new Error('Invalid GitHub tag response')
  const existing = refs.find((ref) => ref.ref === `refs/tags/${tag}`)
  if (existing) {
    let sha = existing.object.sha
    if (existing.object.type === 'tag') {
      sha = JSON.parse(await run('gh', ['api', `${base}/commits/${encodeURIComponent(tag)}`])).sha
    } else if (existing.object.type !== 'commit') throw new Error('Release tag must identify a commit')
    if (sha !== revision) throw new Error(`${tag} already identifies a different revision; prepare a new version`)
  } else if (publish) {
    const created = JSON.parse(await run('gh', ['api', '--method', 'POST', `${base}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${revision}`]))
    if (created.ref !== `refs/tags/${tag}` || created.object?.sha !== revision) throw new Error('Published release tag does not match the verified revision')
  }
  return { tag, revision, published: Boolean(existing) || publish, url: `https://github.com/${repository}/tree/${encodeURIComponent(tag)}` }
}

// Runs outside draining/deployment stages so a metadata retry cannot stop games.
export async function tagReceipt(receipt, repository, run) {
  const metadata = releaseMetadata(receipt)
  if (metadata.tag !== receipt.tag || !receipt.proof?.ok || !Array.isArray(receipt.proof.regions)
    || !receipt.proof.regions.length || receipt.proof.regions.some((region) => region.draining !== false)) {
    throw new Error('A release tag requires a completed, reopened fleet proof')
  }
  return releaseTag({ repository, tag: metadata.tag, revision: receipt.revision, publish: true }, run)
}
