export default {
  app: {
    name: 'cottontail-cli-fixture',
    identifier: 'dev.electrobun.cottontail-cli-fixture',
    version: '0.0.1',
  },
  build: {
    mainProcess: 'cottontail',
    cottontail: {
      entrypoint: 'src/main.ts',
    },
    views: {
      mainview: {
        entrypoint: 'src/views/mainview/index.ts',
        minify: true,
      },
    },
    copy: {
      'src/views/mainview/index.html': 'views/mainview/index.html',
    },
  },
  scripts: {
    postBuild: 'scripts/postBuild.ts',
  },
};
