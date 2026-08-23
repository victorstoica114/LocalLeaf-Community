import './index.css'

const RELEASES_URL = 'https://github.com/victorstoica114/LocalLeaf-Community/releases'
const GITHUB_URL = 'https://github.com/victorstoica114/LocalLeaf-Community'
const DOCS_URL = 'https://github.com/victorstoica114/LocalLeaf-Community#readme'
const ATTRIBUTION_URL = 'https://github.com/victorstoica114/LocalLeaf-Community/blob/main/ATTRIBUTION.md'
const PARTICLES = [
  { left: 8, top: 14, duration: 3.4, delay: 0.2 },
  { left: 18, top: 62, duration: 4.2, delay: 1.1 },
  { left: 29, top: 31, duration: 3.7, delay: 0.7 },
  { left: 39, top: 78, duration: 4.6, delay: 1.5 },
  { left: 48, top: 10, duration: 3.2, delay: 0.4 },
  { left: 58, top: 51, duration: 4.4, delay: 1.8 },
  { left: 67, top: 23, duration: 3.9, delay: 0.9 },
  { left: 76, top: 70, duration: 4.8, delay: 0.1 },
  { left: 86, top: 39, duration: 3.5, delay: 1.3 },
  { left: 94, top: 84, duration: 4.1, delay: 0.6 },
]

function Hero() {
  return (
    <section className="min-h-screen flex flex-col items-center justify-center px-4 py-16 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        {PARTICLES.map((particle, index) => (
          <div
            key={index}
            className="absolute w-2 h-2 bg-green-400 opacity-60"
            style={{
              left: `${particle.left}%`,
              top: `${particle.top}%`,
              animation: `float ${particle.duration}s ease-in-out infinite`,
              animationDelay: `${particle.delay}s`,
            }}
          />
        ))}
      </div>

      <div className="animate-float animate-glow" style={{ marginBottom: '3rem' }}>
        <img
          src="./images/icon.svg"
          alt="LocalLeaf Community logo"
          className="w-32 h-32 md:w-48 md:h-48"
        />
      </div>

      <h1
        className="font-minecraft text-2xl md:text-4xl text-white text-center mb-4 animate-pixel-fade"
        style={{ textShadow: '4px 4px 0px #2E7D32' }}
      >
        LocalLeaf Community
      </h1>

      <p
        className="text-xl md:text-3xl text-white text-center mb-8 animate-pixel-fade animate-delay-1"
        style={{ textShadow: '2px 2px 0px rgba(0,0,0,0.5)' }}
      >
        Local LaTeX editing, synced with Overleaf
      </p>

      <p className="text-lg md:text-2xl text-white/90 text-center max-w-2xl mb-12 animate-pixel-fade animate-delay-2">
        Continue working with Overleaf while using the local editor and tools you already know.
        Built on the original LocalLeaf project and maintained by the community.
      </p>

      <div className="flex flex-col sm:flex-row gap-4 animate-pixel-fade animate-delay-3">
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mc-btn mc-btn-green text-center"
        >
          Community Releases
        </a>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mc-btn text-center"
        >
          Documentation
        </a>
      </div>

      <div className="absolute bottom-8 animate-bounce-subtle">
        <div className="w-8 h-12 border-4 border-white/50 rounded-lg flex justify-center pt-2">
          <div className="w-2 h-3 bg-white/70 rounded-sm" />
        </div>
      </div>
    </section>
  )
}

function Features() {
  const features = [
    {
      icon: '↔',
      title: 'Two-Way Sync',
      description: 'Keep local files and their Overleaf copies in step with each other.',
    },
    {
      icon: '◉',
      title: 'Project Browser',
      description: 'Browse and link your Overleaf projects without leaving VS Code.',
    },
    {
      icon: '⚡',
      title: 'Auto-Sync',
      description: 'Send and receive changes automatically while you work.',
    },
    {
      icon: '⇄',
      title: 'Conflict Resolution',
      description: 'Review competing changes and choose the right version.',
    },
    {
      icon: 'TeX',
      title: 'LaTeX Workshop',
      description: 'Use LaTeX Workshop for local compilation and PDF preview.',
    },
    {
      icon: '—',
      title: 'Ignore Patterns',
      description: 'Keep generated or private files out of sync with .leafignore.',
    },
  ]

  return (
    <section className="py-20 px-4 bg-white/10 backdrop-blur-sm">
      <div style={{ maxWidth: '1152px', marginLeft: 'auto', marginRight: 'auto' }}>
        <h2
          className="font-minecraft text-xl md:text-2xl text-white text-center mb-12"
          style={{ textShadow: '3px 3px 0px #2E7D32' }}
        >
          Features
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <div
              key={feature.title}
              className="feature-card p-6 animate-pixel-fade"
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              <div className="text-4xl mb-4 text-center">{feature.icon}</div>
              <h3 className="font-minecraft text-sm text-gray-800 mb-2 text-center">
                {feature.title}
              </h3>
              <p className="text-xl text-gray-600 text-center">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Steps() {
  const steps = [
    {
      number: 1,
      title: 'Download a Release',
      description: <>
        Download the latest VSIX from <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:text-green-500 underline">GitHub Releases</a>.
      </>,
      code: 'VS Code → Extensions: Install from VSIX...',
    },
    {
      number: 2,
      title: 'Log in to Overleaf',
      description: 'Run "LocalLeaf: Login" and follow the cookie setup instructions.',
      code: 'Ctrl+Shift+P → LocalLeaf: Login',
    },
    {
      number: 3,
      title: 'Link Your Folder',
      description: 'Open a local folder and link it to one of your Overleaf projects.',
      code: 'Ctrl+Shift+P → LocalLeaf: Link Folder',
    },
    {
      number: 4,
      title: 'Start Editing',
      description: 'Work locally and let LocalLeaf synchronize your changes.',
      code: 'Local files ↔ Overleaf project',
    },
  ]

  return (
    <section className="py-20 px-4 ground-section">
      <div style={{ maxWidth: '896px', marginLeft: 'auto', marginRight: 'auto', paddingTop: '2rem' }}>
        <h2
          className="font-minecraft text-xl md:text-2xl text-white text-center mb-12"
          style={{ textShadow: '3px 3px 0px #3E2723' }}
        >
          Getting Started
        </h2>

        <div className="space-y-8">
          {steps.map((step, index) => (
            <div
              key={step.number}
              className="step-card p-6 animate-pixel-fade"
              style={{ animationDelay: `${index * 0.15}s` }}
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-12 h-12 bg-green-600 border-4 border-green-800 flex items-center justify-center">
                  <span className="font-minecraft text-white text-lg">{step.number}</span>
                </div>
                <div className="flex-grow">
                  <h3 className="font-minecraft text-sm text-gray-800 mb-2">{step.title}</h3>
                  <p className="text-xl text-gray-600 mb-3">{step.description}</p>
                  <div className="code-block px-4 py-2 text-lg">{step.code}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="bg-gray-900 text-white py-12 px-4">
      <div style={{ maxWidth: '896px', marginLeft: 'auto', marginRight: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div className="flex flex-wrap justify-center gap-4 mb-8">
          <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="mc-btn mc-btn-green">
            Releases
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="mc-btn">
            GitHub
          </a>
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="mc-btn">
            Documentation
          </a>
        </div>

        <p className="text-xl text-gray-400 mb-4 text-center">
          Inspired by{' '}
          <a
            href="https://github.com/overleaf-workshop/Overleaf-Workshop"
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-400 hover:text-green-300"
          >
            Overleaf-Workshop
          </a>
        </p>

        <p className="text-lg text-gray-500 text-center">
          <a
            href={ATTRIBUTION_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-white"
          >
            Original project by Teddy van Jerry, with community contributions
          </a>
        </p>
      </div>
    </footer>
  )
}

function App() {
  return (
    <div className="min-h-screen w-full">
      <Hero />
      <Features />
      <Steps />
      <Footer />
    </div>
  )
}

export default App
