'use strict';

const razorpayService = require('../../services/razorpay-service');
const walletService = require('../../services/wallet-service');

function createPaymentsModule() {
  return {
    name: 'payments',
    services: {
      razorpayService,
      walletService,
    },
  };
}

module.exports = {
  createPaymentsModule,
};
