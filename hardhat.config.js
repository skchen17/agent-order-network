export default {
  networks: {
    pilotTest: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 84532,
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
