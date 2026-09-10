function validatePromotion({ baseRef, headRef, repository, headRepository }) {
  if (baseRef !== 'main') return;
  if (headRef !== 'develop' || headRepository !== repository) {
    throw new Error('Pull requests into main must promote the repository develop branch. Target develop for individual changes.');
  }
}

if (require.main === module) {
  try {
    validatePromotion({
      baseRef: process.env.GITHUB_BASE_REF,
      headRef: process.env.GITHUB_HEAD_REF,
      repository: process.env.GITHUB_REPOSITORY,
      headRepository: process.env.GITHUB_HEAD_REPOSITORY,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { validatePromotion };
