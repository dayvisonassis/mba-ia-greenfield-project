import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './video-queue.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * The single most consequential ordering rule of this phase: the job must be
 * enqueued only AFTER the transaction commits.
 *
 * Asserting "queue.add was called last" would prove nothing about the database
 * — a spy sees call order, not commit visibility. So this suite observes the
 * row from a SEPARATE connection at the moment the enqueue happens. A second
 * connection can only see committed data, so if the row is visible there, the
 * transaction really did commit first (per phase-03-videos/TD-08).
 */
describe('enqueue happens after commit (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let observer: DataSource;
  let queue: Queue;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        VideosModule,
      ],
    }).compile();
    await module.init();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    // A second, independent connection. It can only ever read committed rows.
    observer = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await observer.initialize();
  });

  afterAll(async () => {
    try {
      await observer.destroy();
    } finally {
      await module.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `order_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `order_ch_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should have the row already committed and visible to another connection when the job is enqueued', async () => {
    const channel = await createChannel();
    const payload = Buffer.from('ordering payload');

    const initiated = await service.initiateUpload(channel.id, {
      original_filename: 'clip.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: payload.length,
    });

    const put = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(payload),
    });
    const etag = put.headers.get('etag')!;

    // Snapshot, taken from the observer connection at enqueue time.
    // Counted locally rather than via the spy: mockRestore() in the finally
    // below clears the spy's call history, so asserting on it after restoring
    // would always read zero.
    let enqueueCalls = 0;
    let statusSeenByObserver: string | undefined;
    let uploadIdSeenByObserver: string | null | undefined;

    // Spy on the queue the SERVICE holds, not on a separately resolved one —
    // that removes any question about whether the two references are the same
    // object and keeps the assertion about the code path under test.
    const serviceQueue = (service as unknown as { queue: Queue }).queue;
    // `.bind` erases the signature to `any`, so the cast is what keeps the
    // call below type-checked.
    const originalAdd = serviceQueue.add.bind(serviceQueue) as Queue['add'];
    const addSpy = jest
      .spyOn(serviceQueue, 'add')
      .mockImplementation(async (name, data, opts) => {
        enqueueCalls += 1;
        const row = await observer
          .getRepository(Video)
          .findOneBy({ id: initiated.id });
        statusSeenByObserver = row?.processing_status;
        uploadIdSeenByObserver = row?.upload_id;
        return originalAdd(name, data, opts);
      });

    try {
      await service.completeUpload(channel.id, initiated.id, {
        parts: [{ part_number: 1, etag }],
      });
    } finally {
      addSpy.mockRestore();
    }

    expect(enqueueCalls).toBe(1);
    // If the enqueue had happened inside the transaction, the observer would
    // still see `uploading` with a non-null upload_id — which is exactly the
    // state a worker would find, and why it would fail.
    expect(statusSeenByObserver).toBe('processing');
    expect(uploadIdSeenByObserver).toBeNull();
  });

  it('should leave no job on the queue when the transaction never commits', async () => {
    const channel = await createChannel();
    const payload = Buffer.from('rollback payload');

    const initiated = await service.initiateUpload(channel.id, {
      original_filename: 'clip.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: payload.length,
    });

    const put = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(payload),
    });
    const etag = put.headers.get('etag')!;

    const transactionSpy = jest
      .spyOn(dataSource, 'transaction')
      .mockRejectedValue(new Error('commit failed'));

    try {
      await expect(
        service.completeUpload(channel.id, initiated.id, {
          parts: [{ part_number: 1, etag }],
        }),
      ).rejects.toThrow('commit failed');
    } finally {
      transactionSpy.mockRestore();
    }

    // Enqueue sits after the transaction, so a failed commit produces no job.
    // The reverse order would leave the worker chasing a row that never moved.
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(
      jobs.some(
        (job) => (job.data as { videoId: string }).videoId === initiated.id,
      ),
    ).toBe(false);
  });
});
