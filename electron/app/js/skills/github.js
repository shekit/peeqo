const config = require('config/config');
const Octokit = require('@octokit/rest');

class PeeqoGithub {
    constructor() {
        this.octokit = new Octokit({
            auth: config.github.accessToken
        });
    }

    listUserRepos(user) {
        this.octokit.repos.listForUser({
            username: user,
            type: 'owner'
        }).then(({ data }) => {
            data.forEach(r => {
               console.log(r);
            });
        });
    }

    listUserPulls(user) {
        // TODO
    }
}

module.exports = PeeqoGithub;
