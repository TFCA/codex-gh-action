import pr from './pr'
import * as core from '@actions/core'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
async function run() {
    try {
        await pr()
    } catch (error) {
        if (core.getInput('NEVER_FAIL') !== 'true') {
            core.setFailed(error)
        }
    }
}

export default run
