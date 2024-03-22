import { readFileSync } from 'fs'
import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
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
        repository: repository.name,
        url: repository.url,
        pull_number: number,
        title: prResponse.data.title ?? '',
        description: prResponse.data.body ?? ''
    }
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
            prDetails.repository,
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
            repo: prDetails.repository,
            base: newBaseSha,
            head: newHeadSha
        })

        diff = String(response.data)
    } else {
        core.debug(`Unsupported event: ${process.env.GITHUB_EVENT_NAME}`)
        core.setFailed(eventData)
        return
    }

    if (!diff) {
        core.debug('No diff found')
        return
    }

    const excludePatterns = core
        .getInput('exclude')
        .split(',')
        .map(s => s.trim())

    const includePatterns = core
        .getInput('include')
        .split(',')
        .map(s => s.trim())

    axios.defaults.headers.common['X-API-Key'] = core.getInput('API_KEY')
    let response
    try {
        response = await axios.post(
            'https://www.codexanalytica.com/api/v0/comment',
            {
                git_diff: diff,
                pull_request: prDetails,
                exclude_patterns: excludePatterns,
                include_patterns: includePatterns
            }
        )
    } catch (e) {
        core.setFailed(e)
        return
    }
    for (const review of response.data) {
        try {
            await createReviewComment(
                octokit,
                prDetails.owner,
                prDetails.repository,
                prDetails.pull_number,
                review['reviews']
            )
        } catch (e) {
            core.setFailed(`${e}: ${JSON.stringify(review)}`)
            //TODO log error to api
        }
    }
}

export default pr
