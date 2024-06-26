import { readFileSync } from 'fs'
import * as core from '@actions/core'
import { setFailed } from '@actions/core'
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

function _setFailed(obj) {
    if (core.getInput('NEVER_FAIL') !== 'true') {
        setFailed(obj)
    }
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

async function getRepoDetails(octokit) {
    const { repository, number } = JSON.parse(
        readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8')
    )
    return {
        owner: repository.owner.login,
        repository: repository.name,
        url: repository.url
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
    const repoDetails = await getRepoDetails(octokit)
    let diff = ''
    const eventData = JSON.parse(
        readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')
    )
    let isPR = false
    const commits = []
    const pusher = eventData['pusher']

    if (eventData.action === 'opened') {
        isPR = true
        diff = await getDiff(
            octokit,
            prDetails.owner,
            prDetails.repository,
            prDetails.pull_number
        )
    } else if (eventData.action === 'synchronize') {
        isPR = true
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
    } else if ('pusher' in eventData) {
        const newBaseSha = eventData.before
        const newHeadSha = eventData.after
        if (
            !newHeadSha ||
            !newBaseSha ||
            newBaseSha === newHeadSha ||
            newBaseSha.startsWith('0000000')
        ) {
            core.setOutput('info', 'Cannot compare this push')
            return
        }

        let response

        try {
            response = await octokit.repos.compareCommits({
                headers: {
                    accept: 'application/vnd.github.v3.diff'
                },
                owner: prDetails.owner,
                repo: prDetails.repository,
                base: newBaseSha,
                head: newHeadSha
            })
        } catch (e) {
            _setFailed(`compare-commits - ${e}: ${newBaseSha} ${newHeadSha}`)
            return
        }

        diff = String(response.data)
        for (const i in eventData['commits']) {
            const commit = eventData['commits'][i]
            commits.push({
                id: commit['id'],
                message: commit['msg'],
                author: commit['author']['email'],
                committer: commit['committer']['email']
            })
        }
    } else {
        core.debug(`Unsupported event: ${process.env.GITHUB_EVENT_NAME}`)
        _setFailed(`Unsupported event: ${eventData}`)
        return
    }

    if (!diff) {
        _setFailed('No diff found')
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
    let result
    const payload = {
        git_diff: diff,
        repository: repoDetails,
        pusher: pusher['email'],
        commits: isPR ? null : commits,
        pull_request: isPR ? prDetails : null,
        exclude_patterns: excludePatterns,
        include_patterns: includePatterns
    }
    try {
        const response = await axios.post(
            'https://api.codexanalytica.com/api/v0/log',
            payload
        )
        result = response.data
    } catch (e) {
        _setFailed(`log - ${e}`)
        return
    }
    try {
        const response = await axios.post(
            'https://api.codexanalytica.com/api/v0/comment',
            payload
        )
        const taskId = response.data['task_id']
        let task = null

        while (
            !task ||
            !task.status ||
            task.status === 'pending' ||
            task.status === 'running'
        ) {
            try {
                const r = await axios.get(
                    `https://api.codexanalytica.com/api/v0/task/${taskId}`
                )
                task = r.data
                await new Promise(resolve => setTimeout(resolve, 1000))
            } catch (error) {
                _setFailed(`Error while waiting for task: ${error}`)
                return
            }
        }
        result = task['result']
    } catch (e) {
        _setFailed(`comment - ${e}: ${payload}`)
        return
    }
    if (isPR) {
        for (const review of result) {
            try {
                await createReviewComment(
                    octokit,
                    prDetails.owner,
                    prDetails.repository,
                    prDetails.pull_number,
                    review['reviews']
                )
            } catch (e) {
                _setFailed(
                    `create-review-comment - ${e}: ${JSON.stringify(review)}`
                )
                //TODO log error to api
            }
        }
    }
}

export default pr
