import { readFileSync } from 'fs'
import * as core from '@actions/core'
import { minimatch } from 'minimatch'
import parseDiff from 'parse-diff'
import { Octokit } from '@octokit/rest'
import OpenAI from 'openai'

import Anthropic from '@anthropic-ai/sdk'
import axios from 'axios'

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

async function sendDiff(diff, pullRequest) {
    try {
        await axios.post('https://code.thefamouscat.com/api/v0/log', {
            diff,
            pullRequest
        })
    } catch (error) {
        console.error(error)
    }
}

async function sendChunk(file, chunk, pullRequest) {
    const response = await axios.post(
        'https://code.thefamouscat.com/api/v0/comment',
        {
            file,
            chunk,
            pullRequest
        }
    )
    return JSON.parse(response.data).reviews
}

async function analyzeCode(dry_run, parsedDiff, prDetails) {
    const comments = []

    for (const file of parsedDiff) {
        if (file.to === '/dev/null') continue // Ignore deleted files
        for (const chunk of file.chunks) {
            const newComments = await sendChunk(file, chunk, prDetails)
            if (newComments) {
                comments.push(...newComments)
            }
        }
    }
    return comments
}

async function getResponse(prompt) {
    const model = core.getInput('LLM_MODEL')
    if (model.startsWith('claude')) {
        return getClaudeResponse(model, prompt)
    } else if (model.startsWith('gpt')) {
        return getGptResponse(model, prompt)
    } else {
        throw new Error(`Unknown model name: ${model}`)
    }
}

async function getClaudeResponse(model, prompt) {
    const anthropic = new Anthropic({
        apiKey: core.getInput('ANTHROPIC_API_KEY')
    })

    const msg = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
    })
    core.setOutput('claude-response', msg)
    try {
        return JSON.parse(msg.content[0].text).reviews
    } catch (e) {
        throw new Error(`${e.message}\n---\n${msg}`)
    }
}

async function getGptResponse(model, prompt) {
    const OPENAI_API_KEY = core.getInput('OPENAI_API_KEY')

    const openai = new OpenAI({
        apiKey: OPENAI_API_KEY
    })

    const queryConfig = {
        model,
        temperature: 0.2,
        max_tokens: 700,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0
    }
    try {
        const response = await openai.chat.completions.create({
            ...queryConfig,
            // return JSON if the model supports it:
            ...(model === 'gpt-4-1106-preview'
                ? { response_format: { type: 'json_object' } }
                : {}),
            messages: [
                {
                    role: 'system',
                    content: prompt
                }
            ]
        })

        const res = response.choices[0].message?.content?.trim() || '{}'
        return JSON.parse(res).reviews
    } catch (error) {
        console.error('Error:', error)
        return null
    }
}

function createComment(file, chunk, aiResponses) {
    return aiResponses.flatMap(aiResponse => {
        if (!file.to) {
            return []
        }
        return {
            body: aiResponse.reviewComment,
            path: file.to,
            line: Number(aiResponse.lineNumber)
        }
    })
}

async function createReviewComment(
    octokit,
    owner,
    repo,
    pull_number,
    comments
) {
    await octokit.pulls.createReview({
        owner,
        repo,
        pull_number,
        comments,
        event: 'COMMENT'
    })
}

function createPrompt(file, chunk, prDetails) {
    return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- IMPORTANT: NEVER mention that changes may affect the behaviour. This is obvious.
- IMPORTANT: Only provide actionable comments. 

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

    const dry_run = core.getInput('dry-run') === 'true'
    const comments = await analyzeCode(dry_run, filteredDiff, prDetails)

    core.setOutput('comments', comments)
    if (dry_run) {
        // do nothing
    } else if (comments.length > 0) {
        await createReviewComment(
            octokit,
            prDetails.owner,
            prDetails.repo,
            prDetails.pull_number,
            comments
        )
    }
}

export default pr
