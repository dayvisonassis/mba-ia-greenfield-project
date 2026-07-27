import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { VideoSlugService } from './video-slug.service';

describe('VideoSlugService', () => {
  let service: VideoSlugService;
  let findOne: jest.Mock;

  beforeEach(async () => {
    findOne = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        VideoSlugService,
        { provide: DataSource, useValue: { manager: { findOne } } },
      ],
    }).compile();

    service = module.get(VideoSlugService);
  });

  it('should return the first slug when nothing collides', async () => {
    findOne.mockResolvedValue(null);

    const slug = await service.generateUniqueSlug();

    expect(slug).toHaveLength(11);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('should retry with a different slug when the first one is taken', async () => {
    // First lookup finds a row; second finds nothing.
    findOne
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValueOnce(null);

    const slug = await service.generateUniqueSlug();

    expect(findOne).toHaveBeenCalledTimes(2);

    const calls = findOne.mock.calls as [
      unknown,
      { where: { slug: string } },
    ][];
    expect(slug).not.toBe(calls[0][1].where.slug);
  });

  it('should throw instead of returning a taken slug once attempts run out', async () => {
    // Every lookup collides — the loop must give up loudly.
    findOne.mockResolvedValue({ id: 'existing' });

    await expect(service.generateUniqueSlug()).rejects.toThrow(
      /after 5 attempts/,
    );
    expect(findOne).toHaveBeenCalledTimes(5);
  });

  it('should generate a thousand slugs with no repetition', async () => {
    findOne.mockResolvedValue(null);

    const slugs = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      slugs.add(await service.generateUniqueSlug());
    }

    expect(slugs.size).toBe(1000);
  });

  it('should produce slugs that fit the column and need no URL escaping', async () => {
    findOne.mockResolvedValue(null);

    for (let i = 0; i < 100; i++) {
      const slug = await service.generateUniqueSlug();

      // Column is varchar(16).
      expect(slug.length).toBeLessThanOrEqual(16);
      expect(slug).toMatch(/^[A-Za-z0-9]+$/);
      // Safe in a path segment as-is.
      expect(encodeURIComponent(slug)).toBe(slug);
    }
  });

  it('should pass the caller transaction manager through when given one', async () => {
    const managerFindOne = jest.fn().mockResolvedValue(null);

    const slug = await service.generateUniqueSlug({
      findOne: managerFindOne,
    } as never);

    // The check must see the caller's uncommitted rows, so it has to run on
    // the caller's manager — not on the service's own DataSource.
    expect(managerFindOne).toHaveBeenCalledTimes(1);
    expect(findOne).not.toHaveBeenCalled();
    expect(slug).toHaveLength(11);
  });
});
