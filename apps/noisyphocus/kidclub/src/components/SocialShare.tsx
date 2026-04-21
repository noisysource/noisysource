
import React from 'react';
import { trackClick } from '../lib/analytics';

interface SocialShareProps {
  url: string;
  title: string;
}

const SocialShare: React.FC<SocialShareProps> = ({ url, title }) => {
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);

  const socialPlatforms = [
    {
      name: 'Facebook',
      shareUrl: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
      icon: (
        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path fillRule="evenodd" d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z" clipRule="evenodd" />
        </svg>
      ),
    },
  ];

  return (
    <div className="flex items-center space-x-4">
      <span className="text-gray-600 font-semibold">Share this:</span>
      {socialPlatforms.map((platform) => (
        <a
          key={platform.name}
          href={platform.shareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-500 hover:text-gray-800 transition-colors duration-300"
          aria-label={`Share on ${platform.name}`}
          onClick={() => trackClick('share', { platform: platform.name, url })}
        >
          {platform.icon}
        </a>
      ))}
    </div>
  );
};

export default SocialShare;
