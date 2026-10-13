/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sealed_auction.json`.
 */
export type SealedAuction = {
  "address": "CjUVaVK3jF9o4EehHWtB13TGg9SPXBWKGBepmZHwyLK2",
  "metadata": {
    "name": "sealedAuction",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Sealed-bid uniform-price auctions for SPL tokens, with bids kept private by Arcium MPC"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "docs": [
        "Second step: the proposed admin accepts."
      ],
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "newAdmin",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "addItems",
      "docs": [
        "Appends items to an item list that is not sealed yet. Each item needs",
        "a name (display text of at most `MAX_ITEM_NAME_LEN` bytes) and at",
        "least one NFT; a list holds at most `MAX_ITEMS` items and",
        "`MAX_COLLECTION_SIZE` NFTs. Items keep their order: the first item's",
        "NFTs are numbers 0 onwards, the next item's follow, and so on."
      ],
      "discriminator": [
        59,
        15,
        197,
        93,
        63,
        10,
        127,
        62
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "itemList"
          ]
        },
        {
          "name": "itemList",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "items",
          "type": {
            "vec": {
              "defined": {
                "name": "newItem"
              }
            }
          }
        }
      ]
    },
    {
      "name": "awardBidCallback",
      "discriminator": [
        80,
        116,
        237,
        216,
        185,
        142,
        254,
        149
      ],
      "accounts": [
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "computationAccount",
          "docs": [
            "against the bid's pending computation."
          ]
        },
        {
          "name": "clusterAccount"
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          },
          "relations": [
            "bid"
          ]
        },
        {
          "name": "bid",
          "writable": true
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "output",
          "type": {
            "defined": {
              "name": "signedComputationOutputs",
              "generics": [
                {
                  "kind": "type",
                  "type": {
                    "defined": {
                      "name": "awardBidOutput"
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    },
    {
      "name": "cancelAuction",
      "docs": [
        "Lets the seller withdraw a token auction that nobody has bid on yet."
      ],
      "discriminator": [
        156,
        43,
        197,
        110,
        218,
        105,
        143,
        182
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "docs": [
            "fee."
          ],
          "writable": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "auction"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "auction"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "sellerTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "seller"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cancelCollectionAuction",
      "docs": [
        "Lets the seller withdraw a collection auction that nobody has bid on",
        "yet. `close_collection_auction` then hands over the empty collection."
      ],
      "discriminator": [
        107,
        42,
        130,
        105,
        215,
        61,
        90,
        129
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "docs": [
            "fee."
          ],
          "writable": true,
          "relations": [
            "auction"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "checkBatch",
      "docs": [
        "Checks the next batch of bids and stores it, encrypted, in the bid",
        "book. Anyone can call this once bidding has closed. Pass the bids with",
        "indices `checked_count..checked_count + min(BATCH_SIZE, remaining)` as",
        "remaining accounts, in order."
      ],
      "discriminator": [
        44,
        249,
        105,
        122,
        223,
        42,
        202,
        223
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "book",
          "docs": [
            "Receives the batch record in the callback."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "signPdaAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  65,
                  114,
                  99,
                  105,
                  117,
                  109,
                  83,
                  105,
                  103,
                  110,
                  101,
                  114,
                  65,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "mempoolAccount",
          "writable": true
        },
        {
          "name": "executingPool",
          "writable": true
        },
        {
          "name": "computationAccount",
          "writable": true
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "clusterAccount",
          "writable": true
        },
        {
          "name": "poolAccount",
          "writable": true,
          "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
        },
        {
          "name": "clockAccount",
          "writable": true,
          "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        }
      ],
      "args": [
        {
          "name": "computationOffset",
          "type": "u64"
        }
      ]
    },
    {
      "name": "checkBidsCallback",
      "discriminator": [
        242,
        239,
        238,
        46,
        82,
        55,
        5,
        253
      ],
      "accounts": [
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "computationAccount",
          "docs": [
            "against the auction's pending computation."
          ]
        },
        {
          "name": "clusterAccount"
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "output",
          "type": {
            "defined": {
              "name": "signedComputationOutputs",
              "generics": [
                {
                  "kind": "type",
                  "type": {
                    "defined": {
                      "name": "checkBidsOutput"
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    },
    {
      "name": "claimCollectionProceeds",
      "docs": [
        "Pays the seller of a collection auction its proceeds, less the",
        "platform's sale fee, on the same conditions as `claim_proceeds`.",
        "Unsold NFTs are simply never minted; winners can still claim theirs",
        "afterwards. A hidden collection pays out only once revealed. If it",
        "sold nothing it can finish without a reveal; if it sold NFTs and was",
        "never revealed, it can finish (with nothing to pay) once the time to",
        "reveal is over and every winner has taken their payment back."
      ],
      "discriminator": [
        47,
        116,
        33,
        105,
        135,
        192,
        137,
        22
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "docs": [
            "fee."
          ],
          "writable": true,
          "relations": [
            "auction"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "claimNfts",
      "docs": [
        "Mints NFTs that a winning bid of a collection auction is owed,",
        "straight to the bid's owner. The bid holds places `first_position`",
        "onwards, one per NFT it won; each place becomes an NFT number through",
        "the shuffle `draw_nft_seed` drew (`shuffled_items`). Should the draw",
        "never have happened by the time the safety net opens, each place is",
        "its own number, so winners can always collect. Pass the asset",
        "addresses of the bid's next places as remaining accounts, writable:",
        "`[ASSET_SEED, auction, place]` for each place from `first_position +",
        "nfts_claimed` on, at most `MAX_NFTS_PER_CLAIM` and no more than the",
        "bid is still owed. Anyone can call it and pays the NFTs' rent; the",
        "NFTs only ever go to the bid's owner. A collection named per item",
        "needs its `item_list`, and a hidden one must have been revealed."
      ],
      "discriminator": [
        185,
        98,
        203,
        203,
        168,
        52,
        91,
        162
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the NFTs' rent."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          },
          "relations": [
            "bid"
          ]
        },
        {
          "name": "bid",
          "writable": true
        },
        {
          "name": "bidder"
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "itemList",
          "docs": [
            "Only for a collection named per item: its item list."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  116,
                  101,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "claimProceeds",
      "docs": [
        "Pays the seller: SOL proceeds, less the platform's sale fee, plus any",
        "unsold tokens. Allowed once every bid is resolved, once an auction",
        "without bids has ended, or once the safety net is open (unsettled bids",
        "then stay refundable by their owners). Tokens that winners have not",
        "collected yet stay in the vault for them."
      ],
      "discriminator": [
        44,
        76,
        121,
        111,
        124,
        251,
        237,
        5
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "docs": [
            "fee."
          ],
          "writable": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "auction"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "auction"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "sellerTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "seller"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimTokens",
      "docs": [
        "Delivers a winning bid's tokens to its owner's associated token",
        "account. Anyone can call it and pays for that account if it does not",
        "exist yet; the tokens only ever go to the bid's owner. Once the seller",
        "has been paid and the last winner has collected, the empty vault is",
        "closed and its rent returned to the seller."
      ],
      "discriminator": [
        108,
        216,
        210,
        231,
        0,
        212,
        42,
        64
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          },
          "relations": [
            "bid"
          ]
        },
        {
          "name": "bid",
          "writable": true
        },
        {
          "name": "bidder"
        },
        {
          "name": "seller",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "auction"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "auction"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "bidderTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "bidder"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "clearPriceCallback",
      "discriminator": [
        153,
        45,
        224,
        151,
        156,
        243,
        184,
        108
      ],
      "accounts": [
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "computationAccount",
          "docs": [
            "against the auction's pending computation."
          ]
        },
        {
          "name": "clusterAccount"
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "output",
          "type": {
            "defined": {
              "name": "signedComputationOutputs",
              "generics": [
                {
                  "kind": "type",
                  "type": {
                    "defined": {
                      "name": "clearPriceOutput"
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    },
    {
      "name": "closeAuction",
      "docs": [
        "Closes a finished or cancelled auction once every bid account is",
        "closed, returning the rent of the auction, its bid book and its vault",
        "to the seller. Nothing is owed to anyone at that point, so tokens still",
        "in the vault (sent there by someone after the sale) go to the seller."
      ],
      "discriminator": [
        225,
        129,
        91,
        48,
        215,
        73,
        203,
        172
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "auction"
          ]
        },
        {
          "name": "vault",
          "docs": [
            "the handler."
          ],
          "writable": true
        },
        {
          "name": "sellerTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "seller"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeBid",
      "docs": [
        "Returns what is left of a settled bid's deposit, plus the account's",
        "rent, to its owner once anything it won has been delivered. Anyone can",
        "call it; the lamports only ever go to the bid's owner."
      ],
      "discriminator": [
        169,
        171,
        66,
        115,
        220,
        168,
        231,
        21
      ],
      "accounts": [
        {
          "name": "bidder",
          "writable": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          },
          "relations": [
            "bid"
          ]
        },
        {
          "name": "bid",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "closeCollectionAuction",
      "docs": [
        "Closes a finished or cancelled collection auction once every bid",
        "account is closed, which means every NFT sold has been minted. Makes",
        "the seller the collection's update authority and returns the rent of",
        "the auction, its bid book and its item list to the seller."
      ],
      "discriminator": [
        83,
        168,
        173,
        31,
        43,
        211,
        29,
        186
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "collection",
          "writable": true
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "itemList",
          "docs": [
            "Only for a collection named per item: its item list, closed here."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  116,
                  101,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeItemList",
      "docs": [
        "Closes an item list that no auction uses, returning its rent to the",
        "seller. A list sealed into an auction closes with it",
        "(`close_collection_auction`)."
      ],
      "discriminator": [
        95,
        37,
        197,
        10,
        151,
        89,
        61,
        53
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "itemList"
          ]
        },
        {
          "name": "itemList",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "createAuction",
      "docs": [
        "Opens a token auction: escrows `terms.supply` base units, creates the",
        "auction's bid book (its rent comes back with `close_auction`) and",
        "charges the listing fee.",
        "",
        "Prices are lamports per `terms.price_unit` base units, a power of ten",
        "up to `MAX_PRICE_UNIT`; bids below `terms.min_price` do not count, and",
        "every bid deposits at least `terms.min_deposit`, its budget. `fees` are",
        "the most the seller accepts to pay; opening fails if the platform's",
        "are higher."
      ],
      "discriminator": [
        234,
        6,
        201,
        246,
        47,
        219,
        176,
        107
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "seller"
              },
              {
                "kind": "arg",
                "path": "seed"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "sellerTokenAccount",
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "`init_if_needed` because anyone can create an associated token account",
            "for any owner; a pre-created vault is still owned by this auction."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "auction"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "feeConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": "u64"
        },
        {
          "name": "terms",
          "type": {
            "defined": {
              "name": "tokenSaleTerms"
            }
          }
        },
        {
          "name": "fees",
          "type": {
            "defined": {
              "name": "feeTerms"
            }
          }
        }
      ]
    },
    {
      "name": "createCollectionAuction",
      "docs": [
        "Opens an auction for a new NFT collection of `terms.supply` items. The",
        "Metaplex Core collection is created here, with the auction as its",
        "update authority so that only this program can add NFTs to it. Each",
        "NFT is minted straight to its winner by `claim_nfts`; unsold NFTs are",
        "never minted. `close_collection_auction` hands the collection to the",
        "seller.",
        "",
        "Prices are ticks of `NFT_PRICE_SCALE` lamports per NFT. A bid asks for",
        "1 to `terms.max_per_bid` NFTs and deposits at least that many times its",
        "price.",
        "",
        "NFT `i` (from 0) is named `\"{item_name} #{i + 1}\"`; its metadata is",
        "`item_uri` followed by `\"{i}.json\"` when `uri_per_item` is set, or",
        "`item_uri` itself otherwise. Which NFT numbers each winner gets is",
        "drawn after the sale (`draw_nft_seed`). A non-zero `royalty_bps` adds",
        "a Royalties plugin that pays the seller on secondary sales.",
        "",
        "With `item_list` (made with `init_item_list` and `add_items` for this",
        "auction's address), NFTs are named per item instead (`item_nft_name`);",
        "the list must add up to the supply, and is sealed here. With",
        "`collection.hidden`, `item_uri` is a commitment: its files need not",
        "exist yet, and NFTs can be claimed only once the seller reveals them",
        "(`reveal_collection`). Both need `uri_per_item`."
      ],
      "discriminator": [
        127,
        184,
        253,
        163,
        26,
        13,
        136,
        1
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "seller"
              },
              {
                "kind": "arg",
                "path": "seed"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "collection",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  101,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "feeConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "mplCoreProgram",
          "address": "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "itemList",
          "docs": [
            "Only for a collection named per item: its item list, sealed here."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  116,
                  101,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": "u64"
        },
        {
          "name": "terms",
          "type": {
            "defined": {
              "name": "collectionSaleTerms"
            }
          }
        },
        {
          "name": "fees",
          "type": {
            "defined": {
              "name": "feeTerms"
            }
          }
        },
        {
          "name": "collection",
          "type": {
            "defined": {
              "name": "collectionTerms"
            }
          }
        }
      ]
    },
    {
      "name": "drawNftSeed",
      "docs": [
        "Has Arcium draw the seed that decides which NFTs each winner of a",
        "collection gets. It can only be drawn once every bid is settled: by",
        "then each winning bid holds its places (`Bid::first_position`), and",
        "nobody knew the seed while they were handed out, so nobody can steer",
        "which NFTs a win becomes. Anyone can call it."
      ],
      "discriminator": [
        164,
        182,
        162,
        102,
        21,
        239,
        198,
        155
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "signPdaAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  65,
                  114,
                  99,
                  105,
                  117,
                  109,
                  83,
                  105,
                  103,
                  110,
                  101,
                  114,
                  65,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "mempoolAccount",
          "writable": true
        },
        {
          "name": "executingPool",
          "writable": true
        },
        {
          "name": "computationAccount",
          "writable": true
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "clusterAccount",
          "writable": true
        },
        {
          "name": "poolAccount",
          "writable": true,
          "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
        },
        {
          "name": "clockAccount",
          "writable": true,
          "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        }
      ],
      "args": [
        {
          "name": "computationOffset",
          "type": "u64"
        }
      ]
    },
    {
      "name": "drawSeedCallback",
      "discriminator": [
        52,
        59,
        163,
        29,
        39,
        222,
        3,
        228
      ],
      "accounts": [
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "computationAccount",
          "docs": [
            "against the auction's pending computation."
          ]
        },
        {
          "name": "clusterAccount"
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "output",
          "type": {
            "defined": {
              "name": "signedComputationOutputs",
              "generics": [
                {
                  "kind": "type",
                  "type": {
                    "defined": {
                      "name": "drawSeedOutput"
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    },
    {
      "name": "emergencyRefund",
      "docs": [
        "Safety net: once `EMERGENCY_DELAY_SECS` have passed since the end of",
        "bidding, an unsettled bid's full deposit and the account's rent go back",
        "to its owner and the bid counts as lost. That includes a collection bid",
        "at the clearing price whose share can no longer be finalized because",
        "another such bid was never revealed. Anyone can call it; the lamports",
        "only ever go to the bid's owner."
      ],
      "discriminator": [
        188,
        73,
        52,
        195,
        137,
        70,
        180,
        147
      ],
      "accounts": [
        {
          "name": "bidder",
          "writable": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          },
          "relations": [
            "bid"
          ]
        },
        {
          "name": "bid",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "finalizeShare",
      "docs": [
        "Settles a collection bid at the clearing price once every such bid is",
        "revealed: they share what the bids above them left, in proportion to",
        "their size and rounded down, and the NFTs lost to rounding go one each",
        "to the earliest of them (lowest bid index), so every NFT is sold.",
        "Anyone can call it; the payment moves to the auction as in any",
        "settlement."
      ],
      "discriminator": [
        60,
        91,
        240,
        43,
        241,
        182,
        67,
        226
      ],
      "accounts": [
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          },
          "relations": [
            "bid"
          ]
        },
        {
          "name": "book",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "bid",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "findClearing",
      "docs": [
        "Reveals the clearing price once every bid is checked, from all the",
        "batch records at once. Anyone can call it."
      ],
      "discriminator": [
        20,
        207,
        254,
        225,
        37,
        60,
        84,
        173
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "book",
          "docs": [
            "Holds every batch record, which the cluster reads in place, and the",
            "deposits."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "signPdaAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  65,
                  114,
                  99,
                  105,
                  117,
                  109,
                  83,
                  105,
                  103,
                  110,
                  101,
                  114,
                  65,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "mempoolAccount",
          "writable": true
        },
        {
          "name": "executingPool",
          "writable": true
        },
        {
          "name": "computationAccount",
          "writable": true
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "clusterAccount",
          "writable": true
        },
        {
          "name": "poolAccount",
          "writable": true,
          "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
        },
        {
          "name": "clockAccount",
          "writable": true,
          "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        }
      ],
      "args": [
        {
          "name": "computationOffset",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initAwardBidCompDef",
      "discriminator": [
        241,
        53,
        92,
        85,
        218,
        122,
        29,
        128
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount",
          "writable": true
        },
        {
          "name": "compDefAccount",
          "writable": true
        },
        {
          "name": "addressLookupTable",
          "writable": true
        },
        {
          "name": "lutProgram",
          "address": "AddressLookupTab1e1111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "circuitUrl",
          "type": "string"
        }
      ]
    },
    {
      "name": "initCheckBidsCompDef",
      "docs": [
        "Registers the `check_bids` circuit. Nodes fetch it from `circuit_url`",
        "and refuse any file whose hash differs from the one compiled into this",
        "program, so the URL's host cannot change what the circuit computes."
      ],
      "discriminator": [
        253,
        240,
        183,
        253,
        150,
        27,
        21,
        242
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount",
          "writable": true
        },
        {
          "name": "compDefAccount",
          "writable": true
        },
        {
          "name": "addressLookupTable",
          "writable": true
        },
        {
          "name": "lutProgram",
          "address": "AddressLookupTab1e1111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "circuitUrl",
          "type": "string"
        }
      ]
    },
    {
      "name": "initClearPriceCompDef",
      "discriminator": [
        171,
        196,
        152,
        68,
        91,
        62,
        97,
        211
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount",
          "writable": true
        },
        {
          "name": "compDefAccount",
          "writable": true
        },
        {
          "name": "addressLookupTable",
          "writable": true
        },
        {
          "name": "lutProgram",
          "address": "AddressLookupTab1e1111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "circuitUrl",
          "type": "string"
        }
      ]
    },
    {
      "name": "initDrawSeedCompDef",
      "discriminator": [
        107,
        76,
        155,
        5,
        150,
        97,
        45,
        201
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount",
          "writable": true
        },
        {
          "name": "compDefAccount",
          "writable": true
        },
        {
          "name": "addressLookupTable",
          "writable": true
        },
        {
          "name": "lutProgram",
          "address": "AddressLookupTab1e1111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "circuitUrl",
          "type": "string"
        }
      ]
    },
    {
      "name": "initItemList",
      "docs": [
        "Starts the item list of the collection auction that the seller will",
        "open with `seed`, for a collection named per item: each item has a",
        "name and a number of NFTs, its editions. `add_items` fills the list",
        "and `create_collection_auction` seals it."
      ],
      "discriminator": [
        94,
        192,
        237,
        99,
        75,
        79,
        157,
        168
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "docs": [
            "is used."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "seller"
              },
              {
                "kind": "arg",
                "path": "seed"
              }
            ]
          }
        },
        {
          "name": "itemList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  116,
                  101,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Creates the platform config. Only the program's upgrade authority can",
        "call this, so nobody can front-run the deployment and claim the admin."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "CjUVaVK3jF9o4EehHWtB13TGg9SPXBWKGBepmZHwyLK2"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "placeBid",
      "docs": [
        "Stores an encrypted bid and escrows its deposit. No MPC runs here, so",
        "bids never contend with each other.",
        "",
        "The ciphertexts encrypt `BidInput { price, quantity }` for the MXE",
        "under the bidder's x25519 key and `nonce`, which must equal `bid_nonce`",
        "of this bid's address. That binding means a ciphertext copied from",
        "another bid decrypts to noise here, so nobody can replay someone else's",
        "bid into an auction whose terms they control and read it from the",
        "result.",
        "",
        "`client_pubkey_edwards_y` is the Edwards y-coordinate of the key, which",
        "lets the program check the key exactly as Arcis does (see",
        "`is_usable_x25519_key`). `terms` are the auction terms the bidder saw;",
        "the bid is refused if the auction does not have exactly those.",
        "",
        "Once the auction holds `MAX_BIDS` bids, pass the bid with the smallest",
        "deposit as `evicted_bid` (and its owner as `evicted_bidder`); the new",
        "deposit must exceed it by `EVICTION_PREMIUM_PERCENT`. The evicted bid",
        "is closed and its owner gets the deposit and rent back.",
        "",
        "For a token auction the deposit is the bid's budget. For a collection",
        "auction a bid whose price times quantity exceeds the deposit counts as",
        "no bid and is fully refunded later; the deposit may exceed that cost",
        "to hide the bid."
      ],
      "discriminator": [
        238,
        77,
        148,
        91,
        200,
        151,
        92,
        146
      ],
      "accounts": [
        {
          "name": "bidder",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        },
        {
          "name": "book",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "bid",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              },
              {
                "kind": "account",
                "path": "bidder"
              },
              {
                "kind": "arg",
                "path": "bidSeed"
              }
            ]
          }
        },
        {
          "name": "evictedBid",
          "docs": [
            "Only when the auction is full: the bid with the smallest deposit,",
            "which this bid replaces."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "evictedBidder",
          "docs": [
            "deposit and rent."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "bidSeed",
          "type": "u64"
        },
        {
          "name": "terms",
          "type": {
            "defined": {
              "name": "expectedTerms"
            }
          }
        },
        {
          "name": "priceCiphertext",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "quantityCiphertext",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "clientPubkey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "clientPubkeyEdwardsY",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "nonce",
          "type": "u128"
        },
        {
          "name": "deposit",
          "type": "u64"
        }
      ]
    },
    {
      "name": "proposeAdmin",
      "docs": [
        "First step of a two-step admin handover."
      ],
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "refundUnrevealed",
      "docs": [
        "When a hidden collection was not revealed in time, gives a winning bid",
        "its payment back. Once `REVEAL_DELAY_SECS` have passed since the end",
        "of bidding and every bid is settled or refunded (the safety net",
        "refunds any that cannot be), the payment moves from the auction back",
        "to the bid, which then counts as having won nothing, so `close_bid`",
        "returns its whole deposit. Anyone can call it; the lamports only go to",
        "the bid."
      ],
      "discriminator": [
        251,
        241,
        202,
        90,
        170,
        175,
        49,
        239
      ],
      "accounts": [
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          },
          "relations": [
            "bid"
          ]
        },
        {
          "name": "bid",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "revealCollection",
      "docs": [
        "Reveals a hidden collection: from now on its NFTs can be claimed, with",
        "the metadata committed when the auction opened (`item_uri`), which",
        "cannot change. Only the seller, once bidding has ended and before",
        "`REVEAL_DELAY_SECS` have passed since. The files must be at",
        "`item_uri` by then; the program cannot see them, but anyone can."
      ],
      "discriminator": [
        181,
        252,
        135,
        115,
        216,
        100,
        60,
        200
      ],
      "accounts": [
        {
          "name": "seller",
          "signer": true,
          "relations": [
            "auction"
          ]
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "setFees",
      "docs": [
        "Sets the platform fees and the wallet that receives them. They apply",
        "to auctions opened afterwards: an auction keeps the sale fee and",
        "treasury it opened with. Both fees are capped (`MAX_LISTING_FEE`,",
        "`MAX_SALE_FEE_BPS`), and sellers name the most they accept when they",
        "open an auction, so a change can never surprise one."
      ],
      "discriminator": [
        137,
        178,
        49,
        58,
        0,
        245,
        242,
        190
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "feeConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "treasury"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "listingFee",
          "type": "u64"
        },
        {
          "name": "saleFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setListing",
      "docs": [
        "Features or hides an auction in the listing. Affects display only."
      ],
      "discriminator": [
        61,
        63,
        131,
        242,
        184,
        230,
        149,
        123
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "auction",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "featured",
          "type": "bool"
        },
        {
          "name": "hidden",
          "type": "bool"
        }
      ]
    },
    {
      "name": "settleBid",
      "docs": [
        "Decides one bid against the public clearing price, from the batch",
        "record `check_batch` stored for it. Anyone can call it. The callback",
        "only records what the bid won and moves the payment to the auction; a",
        "collection bid at the clearing price records its size and waits for",
        "`finalize_share`. Tokens and the unused deposit are collected",
        "afterwards with `claim_tokens` and `close_bid`, so settlement never",
        "depends on the bidder's accounts."
      ],
      "discriminator": [
        39,
        141,
        108,
        215,
        181,
        98,
        229,
        171
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "auction.seller",
                "account": "auction"
              },
              {
                "kind": "account",
                "path": "auction.seed",
                "account": "auction"
              }
            ]
          },
          "relations": [
            "bid"
          ]
        },
        {
          "name": "bid",
          "writable": true
        },
        {
          "name": "book",
          "docs": [
            "Holds the bid's batch record, which the cluster reads in place."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "auction"
              }
            ]
          }
        },
        {
          "name": "signPdaAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  65,
                  114,
                  99,
                  105,
                  117,
                  109,
                  83,
                  105,
                  103,
                  110,
                  101,
                  114,
                  65,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "mempoolAccount",
          "writable": true
        },
        {
          "name": "executingPool",
          "writable": true
        },
        {
          "name": "computationAccount",
          "writable": true
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "clusterAccount",
          "writable": true
        },
        {
          "name": "poolAccount",
          "writable": true,
          "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
        },
        {
          "name": "clockAccount",
          "writable": true,
          "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        }
      ],
      "args": [
        {
          "name": "computationOffset",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "arciumSignerAccount",
      "discriminator": [
        214,
        157,
        122,
        114,
        117,
        44,
        214,
        74
      ]
    },
    {
      "name": "auction",
      "discriminator": [
        86,
        65,
        117,
        99,
        116,
        110,
        48,
        50
      ]
    },
    {
      "name": "bid",
      "discriminator": [
        86,
        66,
        105,
        100,
        95,
        95,
        48,
        50
      ]
    },
    {
      "name": "bidBook",
      "discriminator": [
        86,
        66,
        111,
        111,
        107,
        95,
        48,
        50
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "feeConfig",
      "discriminator": [
        143,
        52,
        146,
        187,
        219,
        123,
        76,
        155
      ]
    },
    {
      "name": "itemList",
      "discriminator": [
        86,
        73,
        116,
        101,
        109,
        115,
        48,
        49
      ]
    }
  ],
  "events": [
    {
      "name": "auctionCancelled",
      "discriminator": [
        22,
        32,
        51,
        83,
        215,
        194,
        171,
        209
      ]
    },
    {
      "name": "auctionCleared",
      "discriminator": [
        14,
        162,
        105,
        210,
        219,
        36,
        142,
        160
      ]
    },
    {
      "name": "auctionClosed",
      "discriminator": [
        104,
        72,
        168,
        177,
        241,
        79,
        231,
        167
      ]
    },
    {
      "name": "auctionCreated",
      "discriminator": [
        133,
        190,
        194,
        65,
        172,
        0,
        70,
        178
      ]
    },
    {
      "name": "batchChecked",
      "discriminator": [
        85,
        248,
        115,
        239,
        150,
        115,
        214,
        236
      ]
    },
    {
      "name": "bidAtClearing",
      "discriminator": [
        93,
        234,
        124,
        224,
        45,
        60,
        87,
        219
      ]
    },
    {
      "name": "bidClosed",
      "discriminator": [
        34,
        163,
        44,
        172,
        23,
        66,
        254,
        237
      ]
    },
    {
      "name": "bidEvicted",
      "discriminator": [
        88,
        141,
        119,
        50,
        79,
        154,
        249,
        94
      ]
    },
    {
      "name": "bidPlaced",
      "discriminator": [
        135,
        53,
        176,
        83,
        193,
        69,
        108,
        61
      ]
    },
    {
      "name": "bidRefunded",
      "discriminator": [
        197,
        100,
        31,
        186,
        67,
        28,
        46,
        103
      ]
    },
    {
      "name": "bidSettled",
      "discriminator": [
        234,
        32,
        141,
        114,
        0,
        102,
        0,
        139
      ]
    },
    {
      "name": "collectionRevealed",
      "discriminator": [
        231,
        191,
        132,
        98,
        26,
        205,
        235,
        38
      ]
    },
    {
      "name": "computationFailed",
      "discriminator": [
        104,
        178,
        218,
        130,
        31,
        33,
        140,
        215
      ]
    },
    {
      "name": "feesUpdated",
      "discriminator": [
        65,
        34,
        234,
        59,
        248,
        242,
        101,
        118
      ]
    },
    {
      "name": "listingUpdated",
      "discriminator": [
        190,
        215,
        199,
        138,
        255,
        248,
        98,
        62
      ]
    },
    {
      "name": "nftsClaimed",
      "discriminator": [
        171,
        139,
        186,
        65,
        26,
        230,
        88,
        201
      ]
    },
    {
      "name": "nftsShuffled",
      "discriminator": [
        69,
        8,
        0,
        46,
        34,
        67,
        168,
        168
      ]
    },
    {
      "name": "proceedsClaimed",
      "discriminator": [
        153,
        159,
        250,
        104,
        73,
        211,
        73,
        9
      ]
    },
    {
      "name": "tokensClaimed",
      "discriminator": [
        25,
        128,
        244,
        55,
        241,
        136,
        200,
        91
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Only the authorized account can do this"
    },
    {
      "code": 6001,
      "name": "invalidPriceUnit",
      "msg": "The price unit must be a power of ten up to 10^16"
    },
    {
      "code": 6002,
      "name": "invalidSupply",
      "msg": "Supply must be between 1 and the maximum for this kind of auction"
    },
    {
      "code": 6003,
      "name": "invalidMaxPerBid",
      "msg": "Most NFTs per bid must be between 1 and the supply"
    },
    {
      "code": 6004,
      "name": "invalidPrice",
      "msg": "The minimum price must be above zero"
    },
    {
      "code": 6005,
      "name": "invalidDuration",
      "msg": "Duration is outside the allowed range"
    },
    {
      "code": 6006,
      "name": "mintAuthorityActive",
      "msg": "The token can still be minted; its mint authority must be revoked"
    },
    {
      "code": 6007,
      "name": "freezeAuthorityActive",
      "msg": "The token can be frozen; its freeze authority must be revoked"
    },
    {
      "code": 6008,
      "name": "unsupportedExtension",
      "msg": "The token uses an extension this platform does not allow"
    },
    {
      "code": 6009,
      "name": "wrongStatus",
      "msg": "The auction is not in the right state for this"
    },
    {
      "code": 6010,
      "name": "biddingClosed",
      "msg": "Bidding has closed"
    },
    {
      "code": 6011,
      "name": "biddingOpen",
      "msg": "Bidding is still open"
    },
    {
      "code": 6012,
      "name": "tooManyBids",
      "msg": "The auction is full; replace the bid with the smallest deposit"
    },
    {
      "code": 6013,
      "name": "depositTooSmall",
      "msg": "Deposit is below the minimum for this auction"
    },
    {
      "code": 6014,
      "name": "hasBids",
      "msg": "The auction already has bids"
    },
    {
      "code": 6015,
      "name": "noBids",
      "msg": "The auction has no bids"
    },
    {
      "code": 6016,
      "name": "nothingToCheck",
      "msg": "Every bid is already checked"
    },
    {
      "code": 6017,
      "name": "wrongBidAccounts",
      "msg": "Bid accounts are missing, out of order or from another auction"
    },
    {
      "code": 6018,
      "name": "bidsNotChecked",
      "msg": "Not every bid has been checked yet"
    },
    {
      "code": 6019,
      "name": "computationInFlight",
      "msg": "A computation for this account is still in flight"
    },
    {
      "code": 6020,
      "name": "unexpectedComputation",
      "msg": "The callback does not belong to the pending computation"
    },
    {
      "code": 6021,
      "name": "invalidClearing",
      "msg": "The clearing result is inconsistent"
    },
    {
      "code": 6022,
      "name": "invalidAllocation",
      "msg": "The allocation result is inconsistent"
    },
    {
      "code": 6023,
      "name": "bidAlreadySettled",
      "msg": "The bid is already settled"
    },
    {
      "code": 6024,
      "name": "oversold",
      "msg": "Allocations would exceed the supply"
    },
    {
      "code": 6025,
      "name": "underfunded",
      "msg": "The payment exceeds the bid's deposit"
    },
    {
      "code": 6026,
      "name": "notSettled",
      "msg": "Not every bid has been settled yet"
    },
    {
      "code": 6027,
      "name": "emergencyActive",
      "msg": "The safety net is open; this auction can no longer progress"
    },
    {
      "code": 6028,
      "name": "tooEarly",
      "msg": "The safety net is not open yet"
    },
    {
      "code": 6029,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6030,
      "name": "invalidNonce",
      "msg": "The bid must be encrypted under the nonce derived from its address"
    },
    {
      "code": 6031,
      "name": "invalidCiphertext",
      "msg": "A ciphertext is not a valid field element"
    },
    {
      "code": 6032,
      "name": "invalidEncryptionKey",
      "msg": "The bid's encryption key is not a usable x25519 key"
    },
    {
      "code": 6033,
      "name": "invalidCircuitUrl",
      "msg": "Circuits must be fetched over https"
    },
    {
      "code": 6034,
      "name": "nothingToClaim",
      "msg": "This bid did not win anything"
    },
    {
      "code": 6035,
      "name": "alreadyClaimed",
      "msg": "What this bid won was already delivered"
    },
    {
      "code": 6036,
      "name": "tokensUnclaimed",
      "msg": "Deliver what this bid won before closing it"
    },
    {
      "code": 6037,
      "name": "termsMismatch",
      "msg": "The auction's terms differ from the ones this bid was made for"
    },
    {
      "code": 6038,
      "name": "notSmallestBid",
      "msg": "Only the bid with the smallest deposit can be replaced"
    },
    {
      "code": 6039,
      "name": "bidsOutstanding",
      "msg": "Some bid accounts of this auction are still open"
    },
    {
      "code": 6040,
      "name": "wrongVault",
      "msg": "This is not the auction's vault"
    },
    {
      "code": 6041,
      "name": "circuitNotPinned",
      "msg": "The computation definition is not the pinned, active circuit"
    },
    {
      "code": 6042,
      "name": "feeTooHigh",
      "msg": "Fees are above the platform's fixed caps"
    },
    {
      "code": 6043,
      "name": "feesChanged",
      "msg": "Platform fees are higher than the ones accepted"
    },
    {
      "code": 6044,
      "name": "invalidTreasury",
      "msg": "The treasury must be the fee wallet: a funded system account"
    },
    {
      "code": 6045,
      "name": "wrongAuctionKind",
      "msg": "This does not apply to this kind of auction"
    },
    {
      "code": 6046,
      "name": "invalidCollectionTerms",
      "msg": "Collection names, metadata links or royalty are invalid"
    },
    {
      "code": 6047,
      "name": "wrongAssetAccounts",
      "msg": "NFT or collection accounts are missing, out of order or wrong"
    },
    {
      "code": 6048,
      "name": "notAtClearing",
      "msg": "Only a collection bid at the clearing price has a share to finalize"
    },
    {
      "code": 6049,
      "name": "sharesNotReady",
      "msg": "Not every bid at the clearing price has been revealed yet"
    },
    {
      "code": 6050,
      "name": "shareReady",
      "msg": "This bid's share is ready; finalize it instead"
    },
    {
      "code": 6051,
      "name": "invalidMinDeposit",
      "msg": "The minimum deposit must be above zero"
    },
    {
      "code": 6052,
      "name": "seedAlreadyDrawn",
      "msg": "The NFTs are already shuffled"
    },
    {
      "code": 6053,
      "name": "nftsNotShuffled",
      "msg": "The NFTs are not shuffled yet; draw the seed first"
    },
    {
      "code": 6054,
      "name": "nothingSold",
      "msg": "No NFTs were sold"
    },
    {
      "code": 6055,
      "name": "invalidItems",
      "msg": "Item names or numbers of NFTs are invalid"
    },
    {
      "code": 6056,
      "name": "tooManyItems",
      "msg": "An item list holds at most 500 items"
    },
    {
      "code": 6057,
      "name": "itemListSealed",
      "msg": "This item list is sealed into an auction"
    },
    {
      "code": 6058,
      "name": "itemListMismatch",
      "msg": "The item list is missing or does not match this auction"
    },
    {
      "code": 6059,
      "name": "notRevealed",
      "msg": "The seller has not revealed this collection yet"
    },
    {
      "code": 6060,
      "name": "alreadyRevealed",
      "msg": "This collection is already revealed, or was never hidden"
    },
    {
      "code": 6061,
      "name": "revealClosed",
      "msg": "The time to reveal this collection is over"
    }
  ],
  "types": [
    {
      "name": "activation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "activationEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "deactivationEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          }
        ]
      }
    },
    {
      "name": "arciumSignerAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "auction",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seed",
            "docs": [
              "Seller-chosen value that, with the seller key, derives this address."
            ],
            "type": "u64"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "auctionKind"
              }
            }
          },
          {
            "name": "mint",
            "docs": [
              "The token, or the collection of a collection auction."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenProgram",
            "docs": [
              "The token's program, or Metaplex Core."
            ],
            "type": "pubkey"
          },
          {
            "name": "supply",
            "docs": [
              "Base units of the token for sale, or NFTs."
            ],
            "type": "u64"
          },
          {
            "name": "priceUnit",
            "docs": [
              "Base units one price refers to; 1 (one NFT) for a collection."
            ],
            "type": "u64"
          },
          {
            "name": "priceScale",
            "docs": [
              "Lamports per price tick: 1 for tokens, `NFT_PRICE_SCALE` for NFTs."
            ],
            "type": "u64"
          },
          {
            "name": "minPrice",
            "docs": [
              "Lowest price that counts, in price ticks."
            ],
            "type": "u32"
          },
          {
            "name": "minDeposit",
            "docs": [
              "Smallest deposit a bid may make, in lamports."
            ],
            "type": "u64"
          },
          {
            "name": "maxPerBid",
            "docs": [
              "Collections: most NFTs one bid may ask for; 0 for tokens."
            ],
            "type": "u16"
          },
          {
            "name": "startTime",
            "type": "i64"
          },
          {
            "name": "endTime",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "auctionStatus"
              }
            }
          },
          {
            "name": "featured",
            "type": "bool"
          },
          {
            "name": "hidden",
            "type": "bool"
          },
          {
            "name": "bidCount",
            "type": "u32"
          },
          {
            "name": "checkedCount",
            "docs": [
              "Bids checked so far, in index order."
            ],
            "type": "u32"
          },
          {
            "name": "resolvedCount",
            "docs": [
              "Bids that are settled or refunded."
            ],
            "type": "u32"
          },
          {
            "name": "liveBids",
            "docs": [
              "Bid accounts of this auction that are not closed yet."
            ],
            "type": "u32"
          },
          {
            "name": "pendingComputation",
            "docs": [
              "Computation account of the auction-level computation in flight, or the",
              "default key when none, with the slot and per-slot counter checked in",
              "its callback."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingSince",
            "type": "i64"
          },
          {
            "name": "pendingSlot",
            "type": "u64"
          },
          {
            "name": "pendingSlotCounter",
            "type": "u16"
          },
          {
            "name": "pendingBatch",
            "docs": [
              "Bids covered by the check in flight."
            ],
            "type": "u8"
          },
          {
            "name": "clearingPrice",
            "docs": [
              "Price every winner pays, in price ticks: the minimum price when",
              "demand never covered the supply."
            ],
            "type": "u32"
          },
          {
            "name": "filled",
            "docs": [
              "Whether demand covered the supply at the minimum price."
            ],
            "type": "bool"
          },
          {
            "name": "weightAbove",
            "docs": [
              "Demand strictly above and exactly at the clearing price: lamports of",
              "budget for tokens, NFTs for a collection."
            ],
            "type": "u128"
          },
          {
            "name": "weightAt",
            "type": "u128"
          },
          {
            "name": "atRevealed",
            "docs": [
              "Collections: NFTs asked for by bids revealed at the clearing price so",
              "far. Once this reaches `weight_at`, their shares can be finalized."
            ],
            "type": "u128"
          },
          {
            "name": "sold",
            "docs": [
              "Base units or NFTs allocated to winners."
            ],
            "type": "u64"
          },
          {
            "name": "delivered",
            "docs": [
              "Base units delivered, or NFTs minted."
            ],
            "type": "u64"
          },
          {
            "name": "proceeds",
            "docs": [
              "Lamports paid by winners, held in this account until claimed."
            ],
            "type": "u64"
          },
          {
            "name": "totalDeposited",
            "docs": [
              "Sum of the deposits of the auction's bids. A replaced bid takes its",
              "deposit out of the total; refunds after bidding ends do not change it."
            ],
            "type": "u64"
          },
          {
            "name": "saleFeeBps",
            "docs": [
              "Platform fee on the proceeds and where it goes, fixed when the auction",
              "opened."
            ],
            "type": "u16"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "bookBump",
            "type": "u8"
          },
          {
            "name": "royaltyBps",
            "docs": [
              "Collection auctions: royalty on secondary sales, paid to the seller."
            ],
            "type": "u16"
          },
          {
            "name": "uriPerItem",
            "docs": [
              "Collection auctions: whether each NFT has its own metadata file",
              "(see `nft_uri`) or all share `item_uri`."
            ],
            "type": "bool"
          },
          {
            "name": "itemName",
            "docs": [
              "Collection auctions: NFT names and metadata (see `nft_name`)."
            ],
            "type": "string"
          },
          {
            "name": "itemUri",
            "type": "string"
          },
          {
            "name": "assignedPositions",
            "docs": [
              "Collection auctions: places handed out so far. Each winning bid takes",
              "the next ones, one per NFT, when it settles (`Bid::first_position`)."
            ],
            "type": "u32"
          },
          {
            "name": "nftSeed",
            "docs": [
              "Collection auctions: the seed `draw_nft_seed` drew once every bid was",
              "settled, which turns places into NFT numbers (`shuffled_items`)."
            ],
            "type": "u128"
          },
          {
            "name": "seedDrawn",
            "type": "bool"
          },
          {
            "name": "namedItems",
            "docs": [
              "Collection auctions: whether NFTs take their names from the auction's",
              "item list (`ItemList`) rather than `item_name`."
            ],
            "type": "bool"
          },
          {
            "name": "unrevealed",
            "docs": [
              "Hidden collections: whether the art is still to be revealed",
              "(`reveal_collection`). Until then no NFT can be claimed."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "auctionCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "auctionCleared",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "clearingPrice",
            "docs": [
              "Price every winner pays, in price ticks."
            ],
            "type": "u32"
          },
          {
            "name": "filled",
            "type": "bool"
          },
          {
            "name": "weightAbove",
            "type": "u128"
          },
          {
            "name": "weightAt",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "auctionClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "sweptAmount",
            "docs": [
              "Tokens found in the vault and sent to the seller."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "auctionCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "auctionKind"
              }
            }
          },
          {
            "name": "seed",
            "type": "u64"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "The token, or the collection of a collection auction."
            ],
            "type": "pubkey"
          },
          {
            "name": "supply",
            "type": "u64"
          },
          {
            "name": "priceUnit",
            "type": "u64"
          },
          {
            "name": "priceScale",
            "type": "u64"
          },
          {
            "name": "minPrice",
            "type": "u32"
          },
          {
            "name": "minDeposit",
            "type": "u64"
          },
          {
            "name": "maxPerBid",
            "type": "u16"
          },
          {
            "name": "endTime",
            "type": "i64"
          },
          {
            "name": "listingFee",
            "docs": [
              "Listing fee paid."
            ],
            "type": "u64"
          },
          {
            "name": "saleFeeBps",
            "docs": [
              "Fee that will be taken from the proceeds."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "auctionKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "token"
          },
          {
            "name": "collection"
          }
        ]
      }
    },
    {
      "name": "auctionStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "settling"
          },
          {
            "name": "finished"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "awardBidOutput",
      "docs": [
        "The output of the callback instruction. Provided as a struct with ordered fields",
        "as anchor does not support tuples and tuple structs yet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": {
              "defined": {
                "name": "awardBidOutputStruct0"
              }
            }
          }
        ]
      }
    },
    {
      "name": "awardBidOutputStruct0",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": "u8"
          },
          {
            "name": "field1",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "bn254g2blsPublicKey",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "array": [
              "u8",
              64
            ]
          }
        ]
      }
    },
    {
      "name": "batchChecked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "checkedCount",
            "type": "u32"
          },
          {
            "name": "bidCount",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "bid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "priceCiphertext",
            "docs": [
              "These two must stay the first fields: the MPC cluster reads them in",
              "place at `BID_CIPHERTEXT_OFFSET`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "quantityCiphertext",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "clientPubkey",
            "docs": [
              "The bidder's x25519 public key used for this encryption."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "type": "u128"
          },
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "index",
            "docs": [
              "Position in the auction's check order."
            ],
            "type": "u32"
          },
          {
            "name": "deposit",
            "docs": [
              "Lamports escrowed in this account on top of its rent; a token bid's",
              "budget."
            ],
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "bidStatus"
              }
            }
          },
          {
            "name": "pendingComputation",
            "docs": [
              "Computation in flight for this bid, with the slot and per-slot counter",
              "checked in its callback."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingSince",
            "type": "i64"
          },
          {
            "name": "pendingSlot",
            "type": "u64"
          },
          {
            "name": "pendingSlotCounter",
            "type": "u16"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "won",
            "docs": [
              "Base units or NFTs won."
            ],
            "type": "u64"
          },
          {
            "name": "payment",
            "docs": [
              "Lamports paid for them."
            ],
            "type": "u64"
          },
          {
            "name": "delivered",
            "docs": [
              "Whether everything this bid won has been delivered."
            ],
            "type": "bool"
          },
          {
            "name": "nftsClaimed",
            "docs": [
              "Collection auctions: NFTs minted to the bidder so far."
            ],
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "firstPosition",
            "docs": [
              "Collection auctions: the first of the places this bid took when it",
              "settled, one per NFT won."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "bidAtClearing",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "docs": [
              "NFTs asked for, which the bid's share at the clearing price depends",
              "on."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidBook",
      "docs": [
        "Per-auction storage too large to keep in `Auction`, which nearly every",
        "instruction loads. Zero-copy, so only the parts used are touched."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "batchRecords",
            "docs": [
              "The MXE-encrypted record of each checked batch: the `(price,",
              "quantity)` of its bids, packed into one ciphertext. Must stay the",
              "first field: the MPC cluster reads records in place at",
              "`BATCH_RECORDS_OFFSET`."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                64
              ]
            }
          },
          {
            "name": "batchNonces",
            "docs": [
              "Little-endian nonce of each batch record."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    16
                  ]
                },
                64
              ]
            }
          },
          {
            "name": "deposits",
            "docs": [
              "Deposit of the bid at each index: the budgets of a token auction, and",
              "how the smallest deposit is found when the auction is full."
            ],
            "type": {
              "array": [
                "u64",
                256
              ]
            }
          },
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "clearingQuantities",
            "docs": [
              "NFTs asked for by the bid at each index if it was revealed at the",
              "clearing price, else 0. `finalize_share` splits what is left there by",
              "these."
            ],
            "type": {
              "array": [
                "u32",
                256
              ]
            }
          }
        ]
      }
    },
    {
      "name": "bidClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "refund",
            "docs": [
              "Unused deposit returned, not counting the account's rent."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidEvicted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "index",
            "type": "u32"
          },
          {
            "name": "refund",
            "docs": [
              "Deposit returned, not counting the account's rent."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidPlaced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "index",
            "type": "u32"
          },
          {
            "name": "deposit",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "won",
            "docs": [
              "Base units or NFTs won."
            ],
            "type": "u64"
          },
          {
            "name": "payment",
            "type": "u64"
          },
          {
            "name": "refund",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "sealed"
          },
          {
            "name": "settled"
          },
          {
            "name": "atClearing"
          }
        ]
      }
    },
    {
      "name": "checkBidsOutput",
      "docs": [
        "The output of the callback instruction. Provided as a struct with ordered fields",
        "as anchor does not support tuples and tuple structs yet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": {
              "defined": {
                "name": "mxeEncryptedStruct",
                "generics": [
                  {
                    "kind": "const",
                    "value": "1"
                  }
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "circuitSource",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "local",
            "fields": [
              {
                "defined": {
                  "name": "localCircuitSource"
                }
              }
            ]
          },
          {
            "name": "onChain",
            "fields": [
              {
                "defined": {
                  "name": "onChainCircuitSource"
                }
              }
            ]
          },
          {
            "name": "offChain",
            "fields": [
              {
                "defined": {
                  "name": "offChainCircuitSource"
                }
              }
            ]
          }
        ]
      }
    },
    {
      "name": "clearPriceOutput",
      "docs": [
        "The output of the callback instruction. Provided as a struct with ordered fields",
        "as anchor does not support tuples and tuple structs yet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": {
              "defined": {
                "name": "clearPriceOutputStruct0"
              }
            }
          }
        ]
      }
    },
    {
      "name": "clearPriceOutputStruct0",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": "u32"
          },
          {
            "name": "field1",
            "type": "u128"
          },
          {
            "name": "field2",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "clockAccount",
      "docs": [
        "An account storing the current network epoch"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "startEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "currentEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "startEpochTimestamp",
            "type": {
              "defined": {
                "name": "timestamp"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "cluster",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tdInfo",
            "type": {
              "option": {
                "defined": {
                  "name": "nodeMetadata"
                }
              }
            }
          },
          {
            "name": "authority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "clusterSize",
            "type": "u16"
          },
          {
            "name": "activation",
            "type": {
              "defined": {
                "name": "activation"
              }
            }
          },
          {
            "name": "maxCapacity",
            "type": "u64"
          },
          {
            "name": "cuPrice",
            "type": "u64"
          },
          {
            "name": "cuPriceProposals",
            "type": {
              "array": [
                "u64",
                32
              ]
            }
          },
          {
            "name": "lastUpdatedEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "nodes",
            "type": {
              "vec": {
                "defined": {
                  "name": "nodeRef"
                }
              }
            }
          },
          {
            "name": "pendingNodes",
            "type": {
              "vec": "u32"
            }
          },
          {
            "name": "blsPublicKey",
            "type": {
              "defined": {
                "name": "setUnset",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "bn254g2blsPublicKey"
                      }
                    }
                  }
                ]
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "currentEpochTotalRewards",
            "type": "u64"
          },
          {
            "name": "rewardsEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "leaderSelector",
            "type": {
              "defined": {
                "name": "leaderSelector"
              }
            }
          }
        ]
      }
    },
    {
      "name": "collectionRevealed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "itemUri",
            "docs": [
              "Where the revealed metadata is, as committed when the auction opened."
            ],
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "collectionSaleTerms",
      "docs": [
        "What a collection auction sells, its minimum price and how long bidding",
        "runs."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "supply",
            "docs": [
              "NFTs for sale."
            ],
            "type": "u64"
          },
          {
            "name": "minPrice",
            "docs": [
              "Lowest price per NFT that counts, in ticks of `NFT_PRICE_SCALE`",
              "lamports."
            ],
            "type": "u32"
          },
          {
            "name": "maxPerBid",
            "docs": [
              "Most NFTs one bid may ask for."
            ],
            "type": "u16"
          },
          {
            "name": "durationSecs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "collectionTerms",
      "docs": [
        "What a collection auction sells (see `create_collection_auction`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "name",
            "docs": [
              "Collection name and metadata URI."
            ],
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
          },
          {
            "name": "itemName",
            "docs": [
              "NFT name, before \" #1\", \" #2\" and so on."
            ],
            "type": "string"
          },
          {
            "name": "itemUri",
            "docs": [
              "NFT metadata: a base URI if `uri_per_item`, else the URI of every NFT."
            ],
            "type": "string"
          },
          {
            "name": "uriPerItem",
            "type": "bool"
          },
          {
            "name": "royaltyBps",
            "docs": [
              "Royalty on secondary sales, paid to the seller; 0 for none."
            ],
            "type": "u16"
          },
          {
            "name": "hidden",
            "docs": [
              "Whether the art stays hidden until the seller reveals it after the",
              "sale (see `reveal_collection`)."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "computationDefinitionAccount",
      "docs": [
        "An account representing a [ComputationDefinition] in a MXE."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "deactivationSlot",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "cuAmount",
            "type": "u64"
          },
          {
            "name": "definition",
            "type": {
              "defined": {
                "name": "computationDefinitionMeta"
              }
            }
          },
          {
            "name": "circuitSource",
            "type": {
              "defined": {
                "name": "circuitSource"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                24
              ]
            }
          }
        ]
      }
    },
    {
      "name": "computationDefinitionMeta",
      "docs": [
        "A computation definition for execution in a MXE."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "circuitLen",
            "type": "u32"
          },
          {
            "name": "signature",
            "type": {
              "defined": {
                "name": "computationSignature"
              }
            }
          }
        ]
      }
    },
    {
      "name": "computationFailed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "computationSignature",
      "docs": [
        "The signature of a computation defined in a [ComputationDefinition]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "parameters",
            "type": {
              "vec": {
                "defined": {
                  "name": "parameter"
                }
              }
            }
          },
          {
            "name": "outputs",
            "type": {
              "vec": {
                "defined": {
                  "name": "output"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "drawSeedOutput",
      "docs": [
        "The output of the callback instruction. Provided as a struct with ordered fields",
        "as anchor does not support tuples and tuple structs yet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "epoch",
      "docs": [
        "The network epoch"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          "u64"
        ]
      }
    },
    {
      "name": "expectedTerms",
      "docs": [
        "The auction terms a bidder saw when signing. `place_bid` refuses the bid",
        "unless the auction has exactly these terms, so neither a stale view nor a",
        "lying RPC node can make a bid land on terms the bidder did not see."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "supply",
            "type": "u64"
          },
          {
            "name": "priceUnit",
            "type": "u64"
          },
          {
            "name": "priceScale",
            "type": "u64"
          },
          {
            "name": "minPrice",
            "type": "u32"
          },
          {
            "name": "minDeposit",
            "type": "u64"
          },
          {
            "name": "maxPerBid",
            "type": "u16"
          },
          {
            "name": "endTime",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feeConfig",
      "docs": [
        "Platform fees for auctions opened from now on (`[FEES_SEED]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listingFee",
            "docs": [
              "Lamports charged to open an auction."
            ],
            "type": "u64"
          },
          {
            "name": "saleFeeBps",
            "docs": [
              "Share of each sale's proceeds, in basis points."
            ],
            "type": "u16"
          },
          {
            "name": "treasury",
            "docs": [
              "System account receiving both fees."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "feePool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "feeTerms",
      "docs": [
        "The most a seller accepts to pay in platform fees. Opening an auction",
        "fails if the current fees are higher."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listingFee",
            "type": "u64"
          },
          {
            "name": "saleFeeBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "feesUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listingFee",
            "type": "u64"
          },
          {
            "name": "saleFeeBps",
            "type": "u16"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "itemList",
      "docs": [
        "The items of a collection auction named per item. Item `k` covers NFT",
        "numbers from the previous item's end (0 for the first) up to its own end.",
        "`count` entries of `ITEM_ENTRY_LEN` bytes follow this header, from",
        "`ITEM_LIST_HEADER_LEN`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "docs": [
              "The auction this list is for (its address, before it exists)."
            ],
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "count",
            "docs": [
              "Entries written so far."
            ],
            "type": "u32"
          },
          {
            "name": "total",
            "docs": [
              "NFTs the entries add up to: the last entry's end."
            ],
            "type": "u32"
          },
          {
            "name": "sealed",
            "docs": [
              "Set when the auction opens with this list; it cannot change after."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "leaderChoice",
      "docs": [
        "The computation chosen by a node to be executed when the node is leader."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offset",
            "type": "u64"
          },
          {
            "name": "slotIdx",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "leaderInfo",
      "docs": [
        "The information about a node."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "stake",
            "type": "u64"
          },
          {
            "name": "count",
            "type": "u64"
          },
          {
            "name": "lastCounterPlusOne",
            "type": "u64"
          },
          {
            "name": "choice",
            "type": {
              "defined": {
                "name": "leaderChoice"
              }
            }
          }
        ]
      }
    },
    {
      "name": "leaderSelector",
      "docs": [
        "To select a Leader.",
        "Uses the greatest divisors method: https://en.wikipedia.org/wiki/D%27Hondt_method"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "stakingEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "info",
            "type": {
              "vec": {
                "defined": {
                  "name": "leaderInfo"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "listingUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "featured",
            "type": "bool"
          },
          {
            "name": "hidden",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "localCircuitSource",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "mxeKeygen"
          },
          {
            "name": "mxeKeyRecoveryInit"
          },
          {
            "name": "mxeKeyRecoveryFinalize"
          }
        ]
      }
    },
    {
      "name": "mxeAccount",
      "docs": [
        "A MPC Execution Environment."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "padding",
            "type": "u8"
          },
          {
            "name": "cluster",
            "type": "u32"
          },
          {
            "name": "keygenOffset",
            "type": "u64"
          },
          {
            "name": "keyRecoveryInitOffset",
            "type": "u64"
          },
          {
            "name": "mxeProgramId",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "utilityPubkeys",
            "type": {
              "defined": {
                "name": "setUnset",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "utilityPubkeys"
                      }
                    }
                  }
                ]
              }
            }
          },
          {
            "name": "lutOffsetSlot",
            "type": "u64"
          },
          {
            "name": "computationDefinitions",
            "type": {
              "vec": "u32"
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "mxeStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "currentEpochRecoveryRewards",
            "type": "u64"
          },
          {
            "name": "recoveryRewardsEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          }
        ]
      }
    },
    {
      "name": "mxeEncryptedStruct",
      "generics": [
        {
          "kind": "const",
          "name": "len",
          "type": "usize"
        }
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
            "type": "u128"
          },
          {
            "name": "ciphertexts",
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                {
                  "generic": "len"
                }
              ]
            }
          }
        ]
      }
    },
    {
      "name": "mxeStatus",
      "docs": [
        "The status of an MXE."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "migration"
          }
        ]
      }
    },
    {
      "name": "newItem",
      "docs": [
        "An item for an item list: its name and how many NFTs it has."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "supply",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "nftsClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "firstPosition",
            "docs": [
              "The first of the bid's places minted now; the others follow it."
            ],
            "type": "u32"
          },
          {
            "name": "items",
            "docs": [
              "The NFT numbers (from 0) minted, one per place; NFT `i` is named",
              "`\"{item_name} #{i + 1}\"`."
            ],
            "type": {
              "vec": "u32"
            }
          }
        ]
      }
    },
    {
      "name": "nftsShuffled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "seed",
            "docs": [
              "Turns places into NFT numbers (see `shuffled_items`)."
            ],
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "nodeMetadata",
      "docs": [
        "location as [ISO 3166-1 alpha-2](https://www.iso.org/iso-3166-country-codes.html) country code"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ip",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "peerId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "location",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "nodeRef",
      "docs": [
        "A reference to a node in the cluster.",
        "The offset is to derive the Node Account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offset",
            "type": "u32"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "vote",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "offChainCircuitSource",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "source",
            "type": "string"
          },
          {
            "name": "hash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "onChainCircuitSource",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isCompleted",
            "type": "bool"
          },
          {
            "name": "uploadAuth",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "output",
      "docs": [
        "An output of a computation.",
        "We currently don't support encrypted outputs yet since encrypted values are passed via",
        "data objects."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "plaintextBool"
          },
          {
            "name": "plaintextU8"
          },
          {
            "name": "plaintextU16"
          },
          {
            "name": "plaintextU32"
          },
          {
            "name": "plaintextU64"
          },
          {
            "name": "plaintextU128"
          },
          {
            "name": "ciphertext"
          },
          {
            "name": "arcisX25519Pubkey"
          },
          {
            "name": "plaintextFloat"
          },
          {
            "name": "plaintextPoint"
          },
          {
            "name": "plaintextI8"
          },
          {
            "name": "plaintextI16"
          },
          {
            "name": "plaintextI32"
          },
          {
            "name": "plaintextI64"
          },
          {
            "name": "plaintextI128"
          }
        ]
      }
    },
    {
      "name": "parameter",
      "docs": [
        "A parameter of a computation.",
        "We differentiate between plaintext and encrypted parameters and data objects.",
        "Plaintext parameters are directly provided as their value.",
        "Encrypted parameters are provided as an offchain reference to the data.",
        "Data objects are provided as a reference to the data object account."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "plaintextBool"
          },
          {
            "name": "plaintextU8"
          },
          {
            "name": "plaintextU16"
          },
          {
            "name": "plaintextU32"
          },
          {
            "name": "plaintextU64"
          },
          {
            "name": "plaintextU128"
          },
          {
            "name": "ciphertext"
          },
          {
            "name": "arcisX25519Pubkey"
          },
          {
            "name": "arcisSignature"
          },
          {
            "name": "plaintextFloat"
          },
          {
            "name": "plaintextI8"
          },
          {
            "name": "plaintextI16"
          },
          {
            "name": "plaintextI32"
          },
          {
            "name": "plaintextI64"
          },
          {
            "name": "plaintextI128"
          },
          {
            "name": "plaintextPoint"
          },
          {
            "name": "unsynchronizedPlaintextBools",
            "fields": [
              "u32"
            ]
          }
        ]
      }
    },
    {
      "name": "proceedsClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "proceeds",
            "docs": [
              "Proceeds before the fee; the seller received `proceeds - fee`."
            ],
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "unsoldAmount",
            "docs": [
              "Unsold tokens returned, or unsold NFTs (never minted)."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "setUnset",
      "docs": [
        "Utility struct to store a value that needs to be set by a certain number of participants (keys",
        "in our case). Once all participants have set the value, the value is considered set and we only",
        "store it once."
      ],
      "generics": [
        {
          "kind": "type",
          "name": "t"
        }
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "set",
            "fields": [
              {
                "generic": "t"
              }
            ]
          },
          {
            "name": "unset",
            "fields": [
              {
                "generic": "t"
              },
              {
                "vec": "bool"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "signedComputationOutputs",
      "generics": [
        {
          "kind": "type",
          "name": "o"
        }
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "success",
            "fields": [
              {
                "generic": "o"
              },
              {
                "array": [
                  "u8",
                  64
                ]
              }
            ]
          },
          {
            "name": "failure"
          },
          {
            "name": "markerForIdlBuildDoNotUseThis",
            "fields": [
              {
                "generic": "o"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "timestamp",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "timestamp",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tokenSaleTerms",
      "docs": [
        "What a token auction sells, its minimum price and how long bidding runs."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "supply",
            "docs": [
              "Base units for sale, escrowed when the auction opens."
            ],
            "type": "u64"
          },
          {
            "name": "priceUnit",
            "docs": [
              "Base units one price refers to: a power of ten up to",
              "`MAX_PRICE_UNIT`."
            ],
            "type": "u64"
          },
          {
            "name": "minPrice",
            "docs": [
              "Lowest price that counts, in lamports per `price_unit`."
            ],
            "type": "u32"
          },
          {
            "name": "minDeposit",
            "docs": [
              "Smallest budget a bid may deposit, in lamports."
            ],
            "type": "u64"
          },
          {
            "name": "durationSecs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "tokensClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "auction",
            "type": "pubkey"
          },
          {
            "name": "bid",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "utilityPubkeys",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "x25519Pubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ed25519VerifyingKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "elgamalPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "pubkeyValidityProof",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    }
  ]
};
