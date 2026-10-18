// RPC endpoints commonly limit block ranges. Persisted cursors belong to the caller.
export async function scanEvents(contract, filter, fromBlock, toBlock, blockSpan = 500) {
  if (!Number.isInteger(blockSpan) || blockSpan < 1 || !Number.isInteger(Number(fromBlock)) || !Number.isInteger(Number(toBlock))) throw new Error("Invalid log scan range");
  const events = [];
  let cursor = Number(fromBlock);
  let span = blockSpan;
  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + span - 1);
    try {
      events.push(...await contract.queryFilter(filter, cursor, end));
      cursor = end + 1;
    } catch (error) {
      if (span <= 1) throw error;
      span = Math.max(1, Math.floor(span / 2));
    }
  }
  return events;
}
