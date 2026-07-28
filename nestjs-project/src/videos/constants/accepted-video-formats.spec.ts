import {
  ACCEPTED_VIDEO_MIMES,
  MAX_VIDEO_SIZE_BYTES,
  isAcceptedFormatName,
  isAcceptedVideoMime,
} from './accepted-video-formats';

describe('accepted-video-formats', () => {
  it('should expose exactly the two browser-native containers', () => {
    // Widening this list is the job of whichever phase adds transcoding —
    // accepting a container the browser cannot play would make "streaming
    // works" true for only part of the uploads.
    expect([...ACCEPTED_VIDEO_MIMES]).toEqual(['video/mp4', 'video/webm']);
  });

  it('should expose the 10 GiB ceiling', () => {
    expect(MAX_VIDEO_SIZE_BYTES).toBe(10_737_418_240);
  });

  describe('isAcceptedVideoMime', () => {
    it.each([...ACCEPTED_VIDEO_MIMES])('should accept %s', (mime) => {
      expect(isAcceptedVideoMime(mime)).toBe(true);
    });

    it.each(['video/x-matroska', 'video/quicktime', 'image/png', ''])(
      'should reject %s',
      (mime) => {
        expect(isAcceptedVideoMime(mime)).toBe(false);
      },
    );
  });

  describe('isAcceptedFormatName', () => {
    it('should accept the ffprobe family string that carries mp4', () => {
      // ffprobe reports MP4 inside a comma-separated family, never alone.
      expect(isAcceptedFormatName('mov,mp4,m4a,3gp,3g2,mj2')).toBe(true);
    });

    it('should accept the ffprobe family string that carries webm', () => {
      expect(isAcceptedFormatName('matroska,webm')).toBe(true);
    });

    it('should reject a container outside the allowlist', () => {
      expect(isAcceptedFormatName('avi')).toBe(false);
      expect(isAcceptedFormatName('flv')).toBe(false);
    });

    it('should tolerate spacing in the family string', () => {
      expect(isAcceptedFormatName('mov, mp4, m4a')).toBe(true);
    });
  });
});
