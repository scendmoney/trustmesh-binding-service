import { Client, PrivateKey, TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import { config } from '../../config';
import { log } from '../../util/log';

let client: Client | null = null;

export const getHederaClient = (): Client => {
    if (client) return client;

    try {
        client = Client.forName(config.HEDERA_NETWORK);
        client.setOperator(config.HEDERA_OPERATOR_ID, config.HEDERA_OPERATOR_KEY);
        return client;
    } catch (error) {
        log.error('Failed to initialize Hedera client', error);
        throw error;
    }
};

export const submitToTopic = async (topicId: string, message: string) => {
    const hederaClient = getHederaClient();

    try {
        const tx = await new TopicMessageSubmitTransaction()
            .setTopicId(topicId)
            .setMessage(message)
            .execute(hederaClient);

        const receipt = await tx.getReceipt(hederaClient);

        return {
            status: 'SUCCESS',
            transactionId: tx.transactionId.toString(),
            topicSequenceNumber: receipt.topicSequenceNumber?.toString(),
            consensusTimestamp: null,
        };
    } catch (error) {
        log.error('Failed to submit to topic', error, { topicId });
        throw error;
    }
};
