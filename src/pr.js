import { readFileSync } from 'fs'
import * as core from '@actions/core'
import { minimatch } from 'minimatch'

import parseDiff from 'parse-diff'
import { Octokit } from '@octokit/rest'

async function getDiff(octokit, owner, repo, pull_number) {
    const response = await octokit.pulls.get({
        owner,
        repo,
        pull_number,
        mediaType: { format: 'diff' }
    })
    // @ts-expect-error - response.data is a string
    return response.data
}

async function getPRDetails(octokit) {
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

function testfun() {
    return 'Hi'
}

async function analyzeCode(parsedDiff, prDetails) {
    const prompts = []

    for (const file of parsedDiff) {
        if (file.to === '/dev/null') continue // Ignore deleted files
        for (const chunk of file.chunks) {
            const prompt = createPrompt(file, chunk, prDetails)
            prompts.push(prompt)
        }
    }
    return prompts
}

function createPrompt(file, chunk, prDetails) {
    return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
        file.to
    }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
    // @ts-expect-error - ln and ln2 exists where needed
    .map(c => `${c.ln ? c.ln : c.ln2} ${c.content}`)
    .join('\n')}
\`\`\`
`
}

async function pr() {
    const octokit = new Octokit({ auth: core.getInput('GITHUB_TOKEN') })
    const prDetails = await getPRDetails(octokit)
    let diff = ''
    const eventData = JSON.parse(
        readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')
    )

    if (eventData.action === 'opened') {
        diff = await getDiff(
            octokit,
            prDetails.owner,
            prDetails.repo,
            prDetails.pull_number
        )
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
        core.debug(`Unsupported event: ${process.env.GITHUB_EVENT_NAME}`)
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
            return minimatch(file.to ?? '', pattern)
        })
    })
    filteredDiff = filteredDiff.filter(file => {
        return includePatterns.some(pattern => {
            return minimatch(file.to ?? '', pattern)
        })
    })
    const prompts = await analyzeCode(filteredDiff, prDetails)
    core.setOutput('prompts', JSON.stringify(prompts))
    core.setOutput('diff', JSON.stringify(filteredDiff))
}

export default pr
