import { readFileSync } from 'fs'
import * as core from '@actions/core'
import minimatch from 'minimatch'

import parseDiff from 'parse-diff'
import { Octokit } from '@octokit/rest'

const octokit = new Octokit({ auth: GITHUB_TOKEN })

async function getDiff(owner, repo, pull_number) {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: 'diff' }
  })
  // @ts-expect-error - response.data is a string
  return response.data
}

async function getPRDetails() {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8')
  )
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number
  })
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? '',
    description: prResponse.data.body ?? ''
  }
}

async function analyzeCode(parsedDiff, prDetails) {
  const comments = []

  for (const file of parsedDiff) {
    if (file.to === '/dev/null') continue // Ignore deleted files
    for (const chunk of file.chunks) {
      comments.push({
        file: file.to,
        line: chunk.line,
        message: chunk.message,
        content: chunk.content,
        changes: chunk.changes,
        title: prDetails.title,
        author: chunk.author
      })
    }
  }
  return comments
}

async function pr() {
  const prDetails = await getPRDetails()
  let diff = ''
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')
  )

  if (eventData.action === 'opened') {
    diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number)
  } else if (eventData.action === 'synchronize') {
    const newBaseSha = eventData.before
    const newHeadSha = eventData.after

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: 'application/vnd.github.v3.diff'
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha
    })

    diff = String(response.data)
  } else {
    core.debug('Unsupported event:' + process.env.GITHUB_EVENT_NAME)
    return
  }

  if (!diff) {
    core.debug('No diff found')
    return
  }

  const parsedDiff = parseDiff(diff)

  const excludePatterns = core
    .getInput('exclude')
    .split(',')
    .map(s => s.trim())

  const includePatterns = core
    .getInput('include')
    .split(',')
    .map(s => s.trim())
  if (includePatterns.length === 0) {
    includePatterns.push('*')
  }

  let filteredDiff = parsedDiff.filter(file => {
    return !excludePatterns.some(pattern => {
      let isMatch = minimatch.minimatch(file.to ?? '', pattern)
      core.error(file + ',' + file.to + ',' + pattern + ': ' + isMatch)
      return isMatch
    })
  })
  filteredDiff = filteredDiff.filter(file => {
    return includePatterns.some(pattern => {
      let isMatch = minimatch.minimatch(file.to ?? '', pattern)
      return isMatch
    })
  })
  const comments = await analyzeCode(filteredDiff, prDetails)
  if (comments.length > 0) {
    core.setOutput('comments', JSON.stringify(comments))
    core.setOutput('diff', JSON.stringify(filteredDiff))
  }
}

module.exports = { pr }
