import React, { useEffect, useRef } from 'react';

export interface WallpaperConfig {
  id: string;
  name: string;
  type: 'canvas' | 'css' | 'image';
  url?: string;
  opacity: number; // 0..1
  blur: number; // px
}

interface WallpaperBackgroundProps {
  config: WallpaperConfig;
}

export const WallpaperBackground: React.FC<WallpaperBackgroundProps> = ({ config }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Animated Starry Night Canvas for Nanami Starry Sky (Default)
  useEffect(() => {
    if (config.id !== 'nanami-starry') return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    // Generate celestial stars
    const numStars = 140;
    const stars = Array.from({ length: numStars }).map(() => ({
      x: Math.random() * width,
      y: Math.random() * (height * 0.75),
      radius: Math.random() * 1.6 + 0.4,
      alpha: Math.random(),
      twinkleSpeed: (Math.random() * 0.02 + 0.005) * (Math.random() > 0.5 ? 1 : -1),
    }));

    // Generate subtle cosmic dust nebulae
    const nebulae = [
      { x: width * 0.3, y: height * 0.25, r: 320, color: 'rgba(30, 58, 138, 0.22)' },
      { x: width * 0.75, y: height * 0.2, r: 380, color: 'rgba(79, 70, 229, 0.18)' },
      { x: width * 0.5, y: height * 0.4, r: 400, color: 'rgba(212, 175, 55, 0.08)' }, // Nanami gold nebula
    ];

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Deep celestial night sky gradient (Navy to deep charcoal)
      const skyGradient = ctx.createLinearGradient(0, 0, 0, height);
      skyGradient.addColorStop(0, '#070913'); // Deep cosmic night
      skyGradient.addColorStop(0.45, '#0B1021'); // Starry indigo
      skyGradient.addColorStop(0.8, '#101426'); // Midnight horizon
      skyGradient.addColorStop(1, '#0c0e17'); // Dark silhouette forest baseline
      ctx.fillStyle = skyGradient;
      ctx.fillRect(0, 0, width, height);

      // Draw nebulae
      nebulae.forEach((neb) => {
        const radGrad = ctx.createRadialGradient(neb.x, neb.y, 10, neb.x, neb.y, neb.r);
        radGrad.addColorStop(0, neb.color);
        radGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = radGrad;
        ctx.beginPath();
        ctx.arc(neb.x, neb.y, neb.r, 0, Math.PI * 2);
        ctx.fill();
      });

      // Draw and twinkle stars
      stars.forEach((star) => {
        star.alpha += star.twinkleSpeed;
        if (star.alpha > 1 || star.alpha < 0.2) {
          star.twinkleSpeed = -star.twinkleSpeed;
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(224, 231, 255, ${Math.max(0.1, Math.min(1, star.alpha))})`;
        ctx.shadowColor = '#D4AF37';
        ctx.shadowBlur = star.radius > 1.2 ? 6 : 2;
        ctx.fill();
        ctx.restore();
      });

      // Distant silhouette treeline / anime scenery bottom horizon
      ctx.fillStyle = '#06070B';
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(0, height - 70);
      for (let i = 0; i <= width; i += 30) {
        const treeH = 50 + Math.sin(i * 0.04) * 20 + Math.cos(i * 0.1) * 15;
        ctx.lineTo(i, height - treeH);
      }
      ctx.lineTo(width, height - 60);
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();

      // Subtle Nanami 7:3 ratio subtle constellation line
      ctx.save();
      ctx.strokeStyle = 'rgba(212, 175, 55, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(width * 0.7, 0);
      ctx.lineTo(width * 0.7, height);
      ctx.stroke();
      ctx.restore();

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
    };
  }, [config.id]);

  return (
    <div
      className="fixed inset-0 pointer-events-none z-0 overflow-hidden transition-all duration-500"
      style={{
        opacity: config.opacity,
        filter: config.blur > 0 ? `blur(${config.blur}px)` : 'none',
      }}
    >
      {config.id === 'nanami-starry' ? (
        <canvas ref={canvasRef} className="w-full h-full object-cover" />
      ) : config.type === 'image' && config.url ? (
        <div
          className="w-full h-full bg-cover bg-center"
          style={{ backgroundImage: `url(${config.url})` }}
        />
      ) : config.id === 'nanami-gold-mesh' ? (
        <div className="w-full h-full bg-[#10121A] bg-[radial-gradient(#D4AF37_1px,transparent_1px)] [background-size:24px_24px] opacity-70" />
      ) : config.id === 'shibuya-cyber' ? (
        <div className="w-full h-full bg-gradient-to-br from-[#0A0D1A] via-[#10182E] to-[#170C24]" />
      ) : (
        <div className="w-full h-full bg-[#12131A]" />
      )}

      {/* Subtle vignette layer to keep text readable */}
      <div className="absolute inset-0 bg-radial from-transparent via-[#12131A]/40 to-[#0A0B10]/80" />
    </div>
  );
};
