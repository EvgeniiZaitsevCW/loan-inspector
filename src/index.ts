import { BlockTag, BytesLike, ethers, Interface, Result } from "ethers";
import { Logger } from "./logger";
import axios, { AxiosResponse } from "axios";
import fs from "fs";

// Script input parameters
const rpcUrl: string = process.env.LI_RPC_URL ?? "http://localhost:8545";
const contractAddress: string = process.env.LI_CONTRACT_ADDRESS ?? "0x0000000000000000000000000000000000000001";
const batchSize: number = parseInt(process.env.LI_BATCH_SIZE ?? "2");

const blockTagsString = process.env.LI_BLOCK_NUMBERS_STING ?? `
67600200
70000000
80000000
`;

const loanIdsString = process.env.LI_LOAN_IDS_STRING ?? `
1
2
3
`;

// Interfaces
interface ParamObject {
  to: string;
  input: string;
}

interface RpcRequest {
  method: string;
  params: (ParamObject | string) [],
  id: number,
  jsonrpc: string
}

interface LoanPreview {
  periodIndex: bigint;
  trackedBalance: bigint;
  outstandingBalance: bigint;
}

interface CallResult {
  id: number,
  loanPreview: LoanPreview;
}

interface RequestWithMetadata {
  id: number;
  blockTag: BlockTag;
  loanId: number;
  rpcRequest: RpcRequest;
}

interface LoanTrackedBalance {
  blockTag: BlockTag;
  loanId: number;
  trackedBalance: number;
}

// Constants
const lendingMarketInterface: Interface = ethers.Interface.from(
  [`function getLoanPreview(
      uint256 loanId,
      uint256 timestamp
    ) external view returns (tuple(uint256 periodIndex, uint256 trackedBalance, uint256 outstandingBalance) preview)`]
);
const lendingMarkerFunctionName = "getLoanPreview";
const requestConfig = {
  headers: { "Content-Type": "application/json" }
};

const logSingleLevelIndent = "  ";
const logger: Logger = new Logger(logSingleLevelIndent);

async function main() {
  logger.log(`🏁 Welcome to Loan Inspector`);
  const loanIds = splitToStringArray(loanIdsString).map(s => parseInt(s));
  const blockTags = splitToBlogTags(blockTagsString);
  logger.log(`ℹ️ Input parameters:`);
  logger.increaseLogIndent();
  logger.log("👉 Number of loan IDs:", loanIds.length);
  logger.log("👉 Number of block tags:", blockTags.length);
  logger.log("👉 Lending market contract address:", contractAddress);
  logger.log("👉 Batch size for RPC requesting:", batchSize);
  logger.decreaseLogIndent();

  logger.log(`▶ Preparing RPC requests ...`);
  const requests: RequestWithMetadata[] = prepareRequests(loanIds, blockTags);
  logger.log(`✅ Done. The requests are prepared.`);

  logger.log(`▶ Sending RPC requests in batches and getting responses ...`);
  logger.increaseLogIndent();
  const callResults: CallResult[] = [];
  for (let i = 0; i < requests.length; i += batchSize) {
    const endIndex = i + batchSize;
    const batchRequests: RpcRequest[] = [];
    for (let j = i; j < endIndex && j < requests.length; ++j) {
      batchRequests.push(requests[j].rpcRequest);
    }
    const beforeBatchTimestamp = Date.now();
    const resp: AxiosResponse = await axios.post(rpcUrl, batchRequests, requestConfig);
    const afterBatchTimestamp = Date.now();

    checkResponse(resp, batchRequests.length);
    const batchCallResults = collectResults(resp, batchRequests.length);
    callResults.push(...batchCallResults);
    logger.log(
      `👉 A batch of requests from ${i} to ${i + batchRequests.length} was sent. ` +
      `A response was received and processed. Response waiting time: ${afterBatchTimestamp - beforeBatchTimestamp} ms.`
    );
  }
  logger.decreaseLogIndent();
  logger.log(`✅ Done. All request have been sent and the responses have received and processed.`);

  logger.log(`▶ Matching the responses with requests and preparing the final report ...`);
  const loanTrackedBalances: LoanTrackedBalance[] = prepareTrackedBalances(requests, callResults);
  logger.log(`✅ Done. The report is ready.`);

  const fileName = "loanTrackedBalances.json";
  fs.writeFileSync(fileName, JSON.stringify(loanTrackedBalances, undefined, 2));

  logger.log("🎉 Everything is done. The file with the loan tracked balances:", fileName);
}

main().then().catch(err => {
  throw err;
});

function splitToStringArray(itemsString: string): string[] {
  const hexNumberArray: string[] = itemsString.split(/[^0-9a-z]+/ig);
  return hexNumberArray.filter(s => s.length > 0);
}

function splitToBlogTags(itemsString: string): BlockTag[] {
  return splitToStringArray(itemsString).map(string => {
    const num = parseInt(string);
    if (isNaN(num)) {
      return string;
    } else {
      return num;
    }
  });
}

function prepareRequests(loanIds: number[], blockTags: BlockTag[]): RequestWithMetadata[] {
  const requests: RequestWithMetadata[] = [];
  let requestId = 1;
  for (const blockTag of blockTags) {
    for (const loanId of loanIds) {
      const data = lendingMarketInterface.encodeFunctionData(lendingMarkerFunctionName, [loanId, 0]);
      const request: RpcRequest = {
        method: "eth_call",
        params: [{ to: contractAddress, input: data }, serializeBlockTag(blockTag)],
        id: requestId,
        jsonrpc: "2.0"
      };
      const requestWithMetadata: RequestWithMetadata = {
        id: requestId,
        blockTag,
        loanId,
        rpcRequest: request
      };
      requests.push(requestWithMetadata);
      ++requestId;
    }
  }
  return requests;
}

function serializeBlockTag(blockTag: BlockTag): string {
  if (blockTag == null) {
    return "latest";
  }
  if (typeof blockTag === "string") {
    return blockTag;
  }
  return "0x" + Number(blockTag).toString(16);
}

function checkResponse(resp: AxiosResponse, dataArrayLength: number) {
  if (dataArrayLength > 0 && !resp.data) {
    throw new Error(`RPC request failed. No "data" field in the response`);
  }
  if (resp.data.length != dataArrayLength) {
    throw new Error(
      `RPC request failed. Insufficient response data array length. ` +
      `Expected: ${dataArrayLength}. Actual: ${resp.data.length}`
    );
  }

  if (dataArrayLength < 1) {
    return;
  }

  const errorItems: any[] = resp.data.filter((item: any) => !item.hasOwnProperty("result"));
  if (errorItems.length > 0) {
    throw new Error(`RPC request failed. ` +
      `An item in the response data array without the result was found. ` +
      `The first error message: '${errorItems[0].error?.message}'. ` +
      `The first error code: ${errorItems[0]?.error?.code}. ` +
      `The full first error object: ${JSON.stringify(errorItems[0]?.error)}.`
    );
  }
}

function collectResults(resp: AxiosResponse, dataArrayLength: number): CallResult[] {
  const callResults: CallResult[] = [];
  if (dataArrayLength < 1) {
    return callResults;
  }
  for (let item of resp.data) {
    callResults.push(convertToCallResult(item));
  }
  return callResults;
}

function convertToCallResult(dataItem: Record<string, unknown>): CallResult {
  const result = lendingMarketInterface.decodeFunctionResult(lendingMarkerFunctionName, dataItem.result as BytesLike);
  const loanPreview = convertToLoanPreview(result);
  return { id: dataItem.id as number, loanPreview };
}

function convertToLoanPreview(result: Result): LoanPreview {
  return {
    periodIndex: result[0].periodIndex,
    trackedBalance: result[0].trackedBalance,
    outstandingBalance: result[0].outstandingBalance,
  };
}

function prepareTrackedBalances(requests: RequestWithMetadata[], callResults: CallResult[]) {
  callResults.sort((a, b) => a.id - b.id);
  const balances: LoanTrackedBalance[] = [];
  for (let i = 0; i < callResults.length; ++i) {
    const callResult = callResults[i];
    const request = requests[i];
    if (callResult.id != request.id) {
      throw Error(`An ID mismatch found. Call result ID: ${callResult.id}. Request ID: ${request.id}`);
    }
    const balance: LoanTrackedBalance = {
      blockTag: request.blockTag,
      loanId: request.loanId,
      trackedBalance: Number(callResult.loanPreview.trackedBalance)
    };
    balances.push(balance);
  }

  return balances;
}