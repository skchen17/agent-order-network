export default {
  networks: {
    pilotTest: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 84532,
      hardfork: "cancun"
    },
    mainnetTest: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 8453,
      hardfork: "cancun"
    },
    local: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      hardfork: "cancun"
    }
  }
};
