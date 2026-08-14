import { runLocalProof } from "../tests/customization/local-proof.mjs";
import { writeReport } from "../tests/customization/test-support.mjs";

const result = await runLocalProof();
const reportPath = writeReport("local-proof-results.json", result);

console.log(JSON.stringify({
  status: result.status,
  steps: result.steps.length,
  reportPath
}, null, 2));
