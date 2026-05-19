const buildDir = cottontail.env('ELECTROBUN_BUILD_DIR');

if (!buildDir) {
  throw new Error('ELECTROBUN_BUILD_DIR was not provided');
}

cottontail.writeFile(`${buildDir}/post-build.txt`, 'post build hook ran\n');
console.log('fixture postBuild hook ran');
