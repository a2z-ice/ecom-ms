import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { userManager } from '../auth/oidcConfig'

export default function LoginPage() {
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const returnUrl = params.get('return') || '/'

    userManager.signinRedirect({ state: { returnUrl } }).catch(err => {
      console.error('Login redirect failed:', err)
      navigate('/')
    })
  }, [navigate])

  return <div className="loading-state">Redirecting to login...</div>
}
