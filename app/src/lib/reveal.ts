// Revealing a hidden drop after its sale: the seller publishes the art, then
// tells the program, which lets winners mint their NFTs.
import { buildRevealCollection } from "./actions";
import { downloadFile, freeTarget, paidTarget } from "./arweave";
import { type Auction, type CollectionMetadata, fetchNftMetadata, nftMetadataUri } from "./chain";
import { type SealedIndex, parseSealedIndex, revealKey } from "./sealed";
import { creditForTotal, ensureCredit, fetchStorageRates, walletSignature, walletUploadKey } from "./storage";
import { type WalletSigner, sendTransaction } from "./tx";
import { publishSealedArt } from "./uploads";

export type RevealStep = "key" | "pay" | "credit" | "publish" | "check" | "reveal";

/** The gateway a metadata link is served from, where files uploaded with it are too. */
function gatewayOf(uri: string): string {
  try {
    return new URL(uri).origin;
  } catch {
    throw new Error("The collection's metadata link is not one this app can read.");
  }
}

/**
 * Reveals a hidden collection. Art sealed by this app is opened with the
 * seller's wallet key and published first; art the seller hosts must already
 * be online. Then the reveal is sent. Returns its signature.
 */
export async function revealArt(
  signer: WalletSigner,
  auction: Auction,
  collectionUri: string,
  metadata: CollectionMetadata | null,
  onStep: (step: RevealStep, progress?: [number, number]) => void
): Promise<string> {
  if (!signer.publicKey.equals(auction.seller)) throw new Error("Only the seller can reveal the art.");
  if (metadata?.sealed) {
    onStep("key");
    const signature = await walletSignature(signer);
    const key = revealKey(signature, auction.address);
    const raw = await downloadFile(metadata.sealed, gatewayOf(collectionUri));
    let index: SealedIndex | null;
    try {
      index = parseSealedIndex(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      index = null;
    }
    if (!index || index.auction !== auction.address.toBase58()) {
      throw new Error("The sealed art's index could not be read, so nothing was published.");
    }
    let target = freeTarget();
    if (index.upload === "paid") {
      const uploadKey = await walletUploadKey(signer);
      target = paidTarget(uploadKey);
      const rates = await fetchStorageRates();
      await ensureCredit(signer, uploadKey, creditForTotal(index.bytes, index.files, rates), rates, (s) =>
        onStep(s === "pay" ? "pay" : "credit")
      );
    }
    onStep("publish", [0, index.files]);
    await publishSealedArt(index, key, auction.itemUri, target, (done, total) => onStep("publish", [done, total]));
  } else {
    // Art the seller hosts: the first NFT's file must answer already.
    onStep("check");
    const first = nftMetadataUri(auction, 0);
    if (!(await fetchNftMetadata(first))) {
      throw new Error(`Put the NFTs' metadata online first: ${first} does not answer yet.`);
    }
  }
  onStep("reveal");
  return sendTransaction(await buildRevealCollection(auction), signer);
}
