import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Log } from '../src/common/logger';
import { window } from './mocks/vscode';

describe('Log lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('ignores late asynchronous writes after its output channel is disposed', () => {
        const logger = new Log('Remote - SSH');
        const output = vi.mocked(window.createOutputChannel).mock.results[0].value;

        logger.info('before dispose');
        logger.dispose();
        logger.trace('late tunnel close');
        logger.error('late socket error');
        logger.show();
        logger.dispose();

        expect(output.appendLine).toHaveBeenCalledTimes(1);
        expect(output.dispose).toHaveBeenCalledTimes(1);
        expect(output.show).not.toHaveBeenCalled();
    });
});
