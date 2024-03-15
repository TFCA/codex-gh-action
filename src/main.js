const core = require('@actions/core')
const pr = require('./pr')

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
async function run() {
  try {
    await pr()
  } catch (error) {
    core.setFailed(error.message)
  }
}

module.exports = {
  run
}
